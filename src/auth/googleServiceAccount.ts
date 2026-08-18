/**
 * Google Service Account OAuth2 token issuance via the JWT Bearer grant
 * (RFC 7523). Used by both the Calendar API integration and FCM HTTP v1
 * sends — no `googleapis` dependency required, just `node:crypto` + `fetch`.
 */
import { createSign } from "node:crypto";
import { base64UrlEncode } from "../utils/base64Url.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKEN_LIFETIME_SECONDS = 3600;
/** Refresh this many seconds before actual expiry to avoid races. */
const EXPIRY_SAFETY_MARGIN_SECONDS = 60;

export interface GoogleServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtEpochSeconds: number;
}

const tokenCache = new Map<string, CachedToken>();

function cacheKeyFor(clientEmail: string, scopes: readonly string[]): string {
  return `${clientEmail}::${[...scopes].sort().join(",")}`;
}

/**
 * Thrown when the platform service-account credentials aren't set — a
 * distinct type (not a plain Error) so callers can tell "this backend
 * isn't configured" apart from "Google's API actually rejected the
 * request", without depending on message-string matching. groqAgent.ts's
 * tool executors special-case this to give the model clear, consistent
 * guidance instead of an opaque technical string — see executeCheckAvailableSlots.
 */
export class GoogleServiceAccountNotConfiguredError extends Error {}

/** Fast, no-throw presence check — lets a caller branch to a degraded/local-only path instead of catching GoogleServiceAccountNotConfiguredError. Same pattern as isElevenLabsConfigured/isGoogleOAuthConfigured. */
export function isGoogleServiceAccountConfigured(): boolean {
  return Boolean(process.env["GOOGLE_SERVICE_ACCOUNT_EMAIL"] && process.env["GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"]);
}

/**
 * Host dashboards (Render included) routinely mangle a multi-line PEM
 * private key on paste — either collapsing it to one line with no `\n`
 * escapes at all, or keeping literal `\n` escapes (handled by the first
 * replace below). If, after unescaping, the key still isn't proper
 * multi-line PEM, this reconstructs it from the BEGIN/END markers plus the
 * base64 body. Skipping this normalization is exactly what produces
 * Node's opaque `error:1E08010C:DECODER routines::unsupported` at sign
 * time rather than a clear "missing credentials" error at startup.
 */
function normalizePemPrivateKey(raw: string): string {
  const unescaped = raw.trim().replace(/\\n/g, "\n");
  if (unescaped.includes("\n")) {
    return unescaped;
  }

  const match = /-----BEGIN ([A-Z ]+)-----(.*)-----END ([A-Z ]+)-----/.exec(unescaped);
  if (!match) {
    // Doesn't even look like PEM — let the caller's signing attempt fail
    // with whatever error node:crypto produces rather than guessing further.
    return unescaped;
  }
  const [, beginLabel, body, endLabel] = match;
  const base64Body = (body ?? "").replace(/\s+/g, "");
  const wrapped = base64Body.match(/.{1,64}/g)?.join("\n") ?? base64Body;
  return `-----BEGIN ${beginLabel}-----\n${wrapped}\n-----END ${endLabel}-----\n`;
}

/**
 * Reads Google service account credentials from environment variables.
 * Throws if either is missing so misconfiguration fails loudly at call time
 * rather than producing a silent, unauthenticated request downstream.
 */
export function loadGoogleServiceAccountCredentials(): GoogleServiceAccountCredentials {
  const clientEmail = process.env["GOOGLE_SERVICE_ACCOUNT_EMAIL"];
  const rawPrivateKey = process.env["GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"];

  if (!clientEmail || !rawPrivateKey) {
    throw new GoogleServiceAccountNotConfiguredError(
      "Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY environment variables.",
    );
  }

  return {
    clientEmail,
    privateKey: normalizePemPrivateKey(rawPrivateKey),
  };
}

function signJwtAssertion(
  credentials: GoogleServiceAccountCredentials,
  scopes: readonly string[],
): string {
  const nowEpochSeconds = Math.floor(Date.now() / 1000);

  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claimSet = base64UrlEncode(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: scopes.join(" "),
      aud: TOKEN_ENDPOINT,
      iat: nowEpochSeconds,
      exp: nowEpochSeconds + TOKEN_LIFETIME_SECONDS,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claimSet}`);
  signer.end();
  const signature = base64UrlEncode(signer.sign(credentials.privateKey));

  return `${header}.${claimSet}.${signature}`;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

function isGoogleTokenResponse(value: unknown): value is GoogleTokenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { access_token?: unknown }).access_token === "string" &&
    typeof (value as { expires_in?: unknown }).expires_in === "number"
  );
}

/**
 * Exchanges a signed JWT assertion for a short-lived OAuth2 access token
 * scoped to `scopes`, caching it in-process until shortly before expiry.
 */
export async function getGoogleAccessToken(
  credentials: GoogleServiceAccountCredentials,
  scopes: readonly string[],
): Promise<string> {
  const cacheKey = cacheKeyFor(credentials.clientEmail, scopes);
  const cached = tokenCache.get(cacheKey);
  const nowEpochSeconds = Math.floor(Date.now() / 1000);

  if (cached && cached.expiresAtEpochSeconds - EXPIRY_SAFETY_MARGIN_SECONDS > nowEpochSeconds) {
    return cached.accessToken;
  }

  const assertion = signJwtAssertion(credentials, scopes);

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Google OAuth2 token exchange failed (${response.status}): ${errorBody}`,
    );
  }

  const payload: unknown = await response.json();
  if (!isGoogleTokenResponse(payload)) {
    throw new Error("Google OAuth2 token exchange returned an unexpected response shape.");
  }

  tokenCache.set(cacheKey, {
    accessToken: payload.access_token,
    expiresAtEpochSeconds: nowEpochSeconds + payload.expires_in,
  });

  return payload.access_token;
}
