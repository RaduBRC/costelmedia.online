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
import { getTenantTwilioRouting } from "../db/supabase.js";

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
}

export async function sendWhatsAppMessage(toPhone: string, body: string, tenantId: string): Promise<void> {
  assertE164(toPhone, "toPhone");
  const credentials = await resolveTwilioCredentials(tenantId);
  await sendViaTwilio(credentials, tenantId, `whatsapp:${credentials.whatsappFromNumber}`, `whatsapp:${toPhone}`, body);
}
