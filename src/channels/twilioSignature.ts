/**
 * Twilio request signature verification, shared by every inbound Twilio
 * webhook (SMS/WhatsApp in src/api/webhooks.ts, Voice in
 * src/telephony/voiceHandler.ts) — one implementation of a security-
 * critical check, not one per route.
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

function computeTwilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const concatenated =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");

  return createHmac("sha1", authToken).update(concatenated, "utf8").digest("base64");
}

function signaturesMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "base64");
  const actualBuffer = Buffer.from(actual, "base64");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Reconstructs the exact URL Twilio signed. Behind a proxy (Render, etc.)
 * `req.protocol`/`req.get('host')` only reflect X-Forwarded-* headers if
 * `trust proxy` is enabled (see src/server/app.ts) — PUBLIC_WEBHOOK_BASE_URL
 * is an escape hatch if your externally-configured Twilio webhook URL ever
 * needs to differ from what Express perceives.
 */
export function reconstructRequestUrl(req: Request): string {
  const override = process.env["PUBLIC_WEBHOOK_BASE_URL"];
  if (override) {
    return `${override.replace(/\/$/, "")}${req.originalUrl}`;
  }
  return `${req.protocol}://${req.get("host") ?? ""}${req.originalUrl}`;
}

export function flattenParsedBody(body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null) {
    return {};
  }
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string") {
      flat[key] = value;
    }
  }
  return flat;
}

/**
 * Verifies `req`'s `X-Twilio-Signature` header against `authToken`. Never
 * throws — a malformed header or body is just "not valid", not a crash.
 */
export function verifyTwilioSignature(req: Request, authToken: string): boolean {
  const signatureHeader = req.get("X-Twilio-Signature");
  if (!signatureHeader) {
    return false;
  }

  const requestUrl = reconstructRequestUrl(req);
  const expectedSignature = computeTwilioSignature(requestUrl, flattenParsedBody(req.body), authToken);

  try {
    return signaturesMatch(expectedSignature, signatureHeader);
  } catch {
    return false;
  }
}

/** Twilio form fields are always plain strings for these webhooks; anything else is malformed. */
export function extractStringFields(body: unknown, fields: readonly string[]): Record<string, string> | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const candidate = body as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const field of fields) {
    const value = candidate[field];
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }
    result[field] = value;
  }
  return result;
}

/** Strips Twilio's `whatsapp:` channel prefix, e.g. "whatsapp:+15551234567" -> "+15551234567". */
export function stripChannelPrefix(phone: string): string {
  return phone.startsWith("whatsapp:") ? phone.slice("whatsapp:".length) : phone;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
