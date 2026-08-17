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
    // .env files typically escape newlines; restore them for PEM parsing.
    privateKey: rawPrivateKey.replace(/\\n/g, "\n"),
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
