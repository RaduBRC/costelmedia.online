/**
 * Outbound SMS/WhatsApp delivery via Twilio's REST API — raw `fetch` +
 * HTTP Basic Auth, no `twilio` SDK dependency (sending a message is a
 * single well-documented POST; a full SDK would be the "unnecessary
 * wrapper library" the project's anti-slop rules warn against).
 *
 * Per-tenant credentials fall back to the platform's shared Twilio account
 * (env vars) when a tenant hasn't brought their own — see
 * getTenantTwilioRouting in src/db/supabase.ts.
 */
import { getTenantTwilioRouting, insertUsageEvent } from "../db/supabase.js";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
/** Minimum spacing between two outbound sends for the same tenant. */
const MIN_SEND_INTERVAL_MS = Number(process.env["TWILIO_MIN_SEND_INTERVAL_MS"] ?? 1100);

export class TwilioDeliveryError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface ResolvedTwilioCredentials {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  whatsappFromNumber: string;
}

/** Exported so the webhook router can verify inbound signatures with the same effective (tenant-or-platform) auth token used to send. */
export async function resolveTwilioCredentials(tenantId: string): Promise<ResolvedTwilioCredentials> {
  const routing = await getTenantTwilioRouting(tenantId);

  const accountSid = routing?.accountSid ?? process.env["TWILIO_ACCOUNT_SID"];
  const authToken = routing?.authToken ?? process.env["TWILIO_AUTH_TOKEN"];
  const fromNumber = routing?.phoneNumber ?? process.env["TWILIO_PHONE_NUMBER"];
  // WhatsApp Business numbers are frequently distinct from the SMS number
  // even for tenants sharing the platform account, so this has its own
  // fallback rather than reusing `fromNumber`.
  const whatsappFromNumber = process.env["TWILIO_WHATSAPP_NUMBER"] ?? fromNumber;

  if (!accountSid || !authToken || !fromNumber || !whatsappFromNumber) {
    throw new TwilioDeliveryError(
      `No Twilio credentials configured for tenant ${tenantId} (tenant-specific or platform TWILIO_* env vars).`,
    );
  }

  return { accountSid, authToken, fromNumber, whatsappFromNumber };
}

// ---------------------------------------------------------------------------
// Rate limiting — simple per-tenant minimum-interval spacing (in-process;
// fine for a single Node instance, which is what the zero-cost deploy
// targets in render.yaml actually run).
// ---------------------------------------------------------------------------

const lastSentAtByTenant = new Map<string, number>();

async function waitForRateLimit(tenantId: string): Promise<void> {
  const lastSentAt = lastSentAtByTenant.get(tenantId);
  const now = Date.now();
  if (lastSentAt !== undefined) {
    const elapsed = now - lastSentAt;
    if (elapsed < MIN_SEND_INTERVAL_MS) {
      await sleep(MIN_SEND_INTERVAL_MS - elapsed);
    }
  }
  lastSentAtByTenant.set(tenantId, Date.now());
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

function assertE164(phone: string, label: string): void {
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw new TwilioDeliveryError(`${label} "${phone}" is not a valid E.164 phone number (expected e.g. +15551234567).`);
  }
}

interface TwilioErrorResponseBody {
  code?: number;
  message?: string;
}

function parseTwilioError(body: string): string {
  try {
    const parsed = JSON.parse(body) as TwilioErrorResponseBody;
    if (parsed.message) {
      return parsed.code ? `${parsed.message} (Twilio error ${parsed.code})` : parsed.message;
    }
  } catch {
    // Fall through to returning the raw body.
  }
  return body;
}

async function sendViaTwilio(
  credentials: ResolvedTwilioCredentials,
  tenantId: string,
  from: string,
  to: string,
  body: string,
): Promise<void> {
  await waitForRateLimit(tenantId);

  const authHeader = `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString("base64")}`;
  const formBody = new URLSearchParams({ From: from, To: to, Body: body });

  let lastError: Error = new TwilioDeliveryError("Twilio send failed for an unknown reason.");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${TWILIO_API_BASE}/Accounts/${credentials.accountSid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody,
      });
    } catch (error) {
      lastError = new TwilioDeliveryError(`Twilio request failed: ${error instanceof Error ? error.message : "network error"}`);
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }

    if (response.ok) {
      return;
    }

    // Twilio rate limiting (429) or a transient server error: back off and retry.
    if (response.status === 429 || response.status >= 500) {
      const errorBody = await response.text();
      lastError = new TwilioDeliveryError(`Twilio send failed (${response.status}): ${parseTwilioError(errorBody)}`);
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }

    // Non-retryable (bad number, unverified sender, etc.).
    const errorBody = await response.text();
    throw new TwilioDeliveryError(`Twilio send failed (${response.status}): ${parseTwilioError(errorBody)}`);
  }

  throw lastError;
}

export async function sendSMSMessage(toPhone: string, body: string, tenantId: string): Promise<void> {
  assertE164(toPhone, "toPhone");
  const credentials = await resolveTwilioCredentials(tenantId);
  await sendViaTwilio(credentials, tenantId, credentials.fromNumber, toPhone, body);
  void insertUsageEvent({ tenantId, service: "twilio_sms", quantity: 1, unit: "messages" });
}

export async function sendWhatsAppMessage(toPhone: string, body: string, tenantId: string): Promise<void> {
  assertE164(toPhone, "toPhone");
  const credentials = await resolveTwilioCredentials(tenantId);
  await sendViaTwilio(credentials, tenantId, `whatsapp:${credentials.whatsappFromNumber}`, `whatsapp:${toPhone}`, body);
  void insertUsageEvent({ tenantId, service: "twilio_sms", quantity: 1, unit: "messages" });
}

// ---------------------------------------------------------------------------
// Number provisioning — the self-service alternative to "ask support to set
// up a number manually". Two distinct operations on purpose:
//   - searchAvailableTwilioNumbers: read-only, free (Twilio doesn't charge
//     for searching), safe to call as often as a tenant wants while
//     browsing options.
//   - purchaseTwilioNumber: REAL MONEY — actually buys a phone number on
//     the tenant's (or platform's) Twilio account and starts its monthly
//     rental charge immediately. Never call this speculatively or as part
//     of a test; it must only ever run from an explicit, confirmed user
//     action (see the route's own comment, tenantSettings.ts).
// ---------------------------------------------------------------------------

export interface AvailableTwilioNumber {
  phoneNumber: string;
  friendlyName: string;
  locality: string | null;
  region: string | null;
  monthlyPriceHint: string;
}

interface TwilioAvailableNumberApiEntry {
  phone_number?: string;
  friendly_name?: string;
  locality?: string | null;
  region?: string | null;
}

/**
 * GET AvailablePhoneNumbers — Twilio's own search, no purchase happens
 * here. `monthlyPriceHint` is a fixed, hand-maintained estimate (Twilio's
 * available-numbers endpoint doesn't return pricing at all; actual price
 * depends on the number type/country and can change) — labelled as a
 * hint, not a quote, precisely because of that; the real charge is
 * whatever Twilio's pricing page/invoice says.
 */
export async function searchAvailableTwilioNumbers(
  countryCode: string,
  areaCode: string | undefined,
  credentials: Pick<ResolvedTwilioCredentials, "accountSid" | "authToken">,
): Promise<AvailableTwilioNumber[]> {
  const authHeader = `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString("base64")}`;
  const params = new URLSearchParams({ VoiceEnabled: "true", SmsEnabled: "true" });
  if (areaCode) {
    params.set("AreaCode", areaCode);
  }

  const response = await fetch(
    `${TWILIO_API_BASE}/Accounts/${credentials.accountSid}/AvailablePhoneNumbers/${countryCode}/Local.json?${params.toString()}`,
    { headers: { Authorization: authHeader } },
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new TwilioDeliveryError(`Twilio number search failed (${response.status}): ${parseTwilioError(errorBody)}`);
  }

  const payload = (await response.json()) as { available_phone_numbers?: TwilioAvailableNumberApiEntry[] };
  return (payload.available_phone_numbers ?? [])
    .filter((entry): entry is TwilioAvailableNumberApiEntry & { phone_number: string } => typeof entry.phone_number === "string")
    .map((entry) => ({
      phoneNumber: entry.phone_number,
      friendlyName: entry.friendly_name ?? entry.phone_number,
      locality: entry.locality ?? null,
      region: entry.region ?? null,
      // Twilio's standard US/CA local number rate as of this writing —
      // see this function's own header comment for why it's a hint, not
      // a live quote.
      monthlyPriceHint: "~$1.15/month + usage",
    }));
}

/**
 * POST IncomingPhoneNumbers.json — REAL MONEY, see this section's header
 * comment. Sets the VoiceUrl to this app's own inbound Twilio webhook
 * (voiceHandler.ts) at purchase time, so the number is immediately
 * call-ready with no separate configuration step.
 */
export async function purchaseTwilioNumber(
  phoneNumber: string,
  voiceWebhookUrl: string,
  credentials: Pick<ResolvedTwilioCredentials, "accountSid" | "authToken">,
): Promise<{ sid: string; phoneNumber: string }> {
  const authHeader = `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString("base64")}`;
  const formBody = new URLSearchParams({ PhoneNumber: phoneNumber, VoiceUrl: voiceWebhookUrl, VoiceMethod: "POST" });

  const response = await fetch(`${TWILIO_API_BASE}/Accounts/${credentials.accountSid}/IncomingPhoneNumbers.json`, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new TwilioDeliveryError(`Twilio number purchase failed (${response.status}): ${parseTwilioError(errorBody)}`);
  }

  const payload = (await response.json()) as { sid?: string; phone_number?: string };
  if (!payload.sid || !payload.phone_number) {
    throw new TwilioDeliveryError("Twilio number purchase response was missing sid/phone_number.");
  }
  return { sid: payload.sid, phoneNumber: payload.phone_number };
}
