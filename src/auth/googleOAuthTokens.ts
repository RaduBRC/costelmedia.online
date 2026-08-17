/**
 * Per-tenant Google OAuth2 connection: authorization URL, code exchange,
 * refresh, and AES-256-GCM encryption of everything before it touches
 * Supabase. This is a *parallel* auth path to googleServiceAccount.ts's
 * platform-wide service account — a tenant that connects here gets their
 * own Google account used instead (see googleCalendarEngine.ts's token
 * resolution), but nothing about the service-account path changes for
 * tenants who never connect.
 *
 * Scopes requested are intentionally narrower than calendar.readonly +
 * calendar.events (the two-scope combination the original ask specified)
 * — a single `calendar` scope (full read/write) is what's actually needed
 * (freebusy reads + event insert/delete) and is what CALENDAR_SCOPES in
 * googleCalendarEngine.ts already uses for the service-account path;
 * requesting two overlapping scopes here would just be redundant consent
 * for the same access.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  clearGoogleOAuthTokens,
  getGoogleOAuthTokenRow,
  setGoogleOAuthTokens,
  updateGoogleOAuthAccessToken,
} from "../db/supabase.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_OAUTH_SCOPES = ["https://www.googleapis.com/auth/calendar"] as const;

/** Refresh this many seconds before actual expiry, matching googleServiceAccount.ts's own safety margin. */
const EXPIRY_SAFETY_MARGIN_SECONDS = 300;

export class GoogleOAuthNotConfiguredError extends Error {}

// ---------------------------------------------------------------------------
// AES-256-GCM encryption
//
// Format: base64(iv [12 bytes] || authTag [16 bytes] || ciphertext) — one
// string, nothing to store alongside it. A fresh random iv every call
// (required for GCM; reusing an iv with the same key breaks its security
// guarantees entirely), so encrypting the same token twice produces two
// different ciphertexts — expected, not a bug.
// ---------------------------------------------------------------------------

function loadEncryptionKey(): Buffer {
  const raw = process.env["GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY"];
  if (!raw) {
    throw new GoogleOAuthNotConfiguredError("Missing GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY environment variable.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new GoogleOAuthNotConfiguredError(
      `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes for AES-256-GCM; got ${key.length}. Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}

function encryptToken(plaintext: string): string {
  const key = loadEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

function decryptToken(encrypted: string): string {
  const key = loadEncryptionKey();
  const raw = Buffer.from(encrypted, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// OAuth client credentials
// ---------------------------------------------------------------------------

interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function loadOAuthClientConfig(): OAuthClientConfig {
  const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
  const redirectUri = process.env["GOOGLE_OAUTH_REDIRECT_URI"];
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleOAuthNotConfiguredError(
      "Missing one or more of GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI — create an OAuth 2.0 Client ID (Web application type) in Google Cloud Console and register the redirect URI there.",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/** Fast, no-network check — same "fail before a network call that was never going to work" pattern as isElevenLabsConfigured. */
export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    process.env["GOOGLE_OAUTH_CLIENT_ID"] && process.env["GOOGLE_OAUTH_CLIENT_SECRET"] && process.env["GOOGLE_OAUTH_REDIRECT_URI"],
  );
}

// ---------------------------------------------------------------------------
// OAuth `state` — binds a /callback request back to the tenant that
// started the flow, since that request carries no Authorization header
// (see src/api/routes/googleIntegration.ts's file header). A signed,
// self-contained token rather than a server-side session store: no new
// infra (Redis, a sessions table) needed for what's fundamentally a
// short-lived CSRF-binding value. Reuses the encryption key as an HMAC
// key — this token isn't secret (it's echoed right back in a URL), it
// just needs to be unforgeable, which HMAC-SHA256 with any 32-byte key
// gives regardless of which key.
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1000;

export function signOAuthState(tenantId: string): string {
  const nonce = randomBytes(9).toString("base64url");
  const payload = `${tenantId}.${Date.now()}.${nonce}`;
  const signature = createHmac("sha256", loadEncryptionKey()).update(payload).digest("base64url");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${signature}`;
}

/** Returns the embedded tenantId if `state` has a valid signature and hasn't expired, otherwise null. */
export function verifyOAuthState(state: string): string | null {
  const [payloadB64, signature] = state.split(".");
  if (!payloadB64 || !signature) {
    return null;
  }

  const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  const expectedSignature = createHmac("sha256", loadEncryptionKey()).update(payload).digest("base64url");

  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  const [tenantId, timestampStr] = payload.split(".");
  const timestamp = Number(timestampStr);
  if (!tenantId || !Number.isFinite(timestamp) || Date.now() - timestamp > STATE_TTL_MS) {
    return null;
  }
  return tenantId;
}

/**
 * Builds the Google consent-screen URL. `state` should be a short-lived,
 * unguessable token the caller can verify on the way back (see
 * src/api/routes/googleIntegration.ts's /auth handler for how it's
 * generated and bound to req.tenantId) — without it, nothing stops the
 * callback from being replayed against a different tenant than the one
 * that started the flow.
 */
export function buildGoogleOAuthConsentUrl(state: string): string {
  const config = loadOAuthClientConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface GoogleOAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

function isGoogleOAuthTokenResponse(value: unknown): value is GoogleOAuthTokenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { access_token?: unknown }).access_token === "string" &&
    typeof (value as { expires_in?: unknown }).expires_in === "number"
  );
}

/**
 * Exchanges an authorization code for a token pair and stores it encrypted
 * against `tenantId`, flipping google_sync_enabled on. Google only returns
 * `refresh_token` on the *first* consent for a given user+client (or any
 * consent with prompt=consent, which buildGoogleOAuthConsentUrl always
 * sets) — if it's missing here despite that, something about the OAuth
 * client config is off, so this throws rather than silently storing a
 * connection that can never refresh itself past the first hour.
 */
export async function connectTenantGoogleAccount(tenantId: string, code: string): Promise<void> {
  const config = loadOAuthClientConfig();

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google OAuth code exchange failed (${response.status}): ${errorBody}`);
  }

  const payload: unknown = await response.json();
  if (!isGoogleOAuthTokenResponse(payload)) {
    throw new Error("Google OAuth code exchange returned an unexpected response shape.");
  }
  if (!payload.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token — this connection cannot be kept alive past the first hour. Disconnect any prior grant for this app in https://myaccount.google.com/permissions and try connecting again.",
    );
  }

  const expiresAt = new Date(Date.now() + payload.expires_in * 1000).toISOString();
  await setGoogleOAuthTokens(tenantId, {
    encryptedAccessToken: encryptToken(payload.access_token),
    encryptedRefreshToken: encryptToken(payload.refresh_token),
    tokenExpiry: expiresAt,
  });
}

/** Revokes the token with Google (best-effort — a revoke failure still proceeds to clear our own stored copy, since an unreachable Google API shouldn't leave a tenant stuck "connected" in our UI) and clears stored tokens. */
export async function disconnectTenantGoogleAccount(tenantId: string): Promise<void> {
  const row = await getGoogleOAuthTokenRow(tenantId);
  if (row?.encryptedRefreshToken) {
    try {
      const refreshToken = decryptToken(row.encryptedRefreshToken);
      await fetch(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }),
      });
    } catch (error) {
      console.warn(`[Google OAuth] Revoke request failed for tenant ${tenantId} (clearing local tokens anyway):`, error);
    }
  }
  await clearGoogleOAuthTokens(tenantId);
}

/**
 * Returns a currently-valid plaintext access token for this tenant's own
 * connected Google account, refreshing first if it's expired or expiring
 * within EXPIRY_SAFETY_MARGIN_SECONDS — or `null` if the tenant has never
 * connected one (google_sync_enabled is false), which callers
 * (googleCalendarEngine.ts) treat as "fall back to the service account",
 * not as an error.
 */
export async function getValidGoogleOAuthAccessToken(tenantId: string): Promise<string | null> {
  const row = await getGoogleOAuthTokenRow(tenantId);
  if (!row || !row.syncEnabled || !row.encryptedAccessToken || !row.encryptedRefreshToken) {
    return null;
  }

  const expiresAtMs = row.tokenExpiry ? new Date(row.tokenExpiry).getTime() : 0;
  const isFresh = expiresAtMs - EXPIRY_SAFETY_MARGIN_SECONDS * 1000 > Date.now();
  if (isFresh) {
    return decryptToken(row.encryptedAccessToken);
  }

  const config = loadOAuthClientConfig();
  const refreshToken = decryptToken(row.encryptedRefreshToken);

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google OAuth token refresh failed for tenant ${tenantId} (${response.status}): ${errorBody}`);
  }

  const payload: unknown = await response.json();
  if (!isGoogleOAuthTokenResponse(payload)) {
    throw new Error("Google OAuth token refresh returned an unexpected response shape.");
  }

  const newExpiresAt = new Date(Date.now() + payload.expires_in * 1000).toISOString();
  await updateGoogleOAuthAccessToken(tenantId, { encryptedAccessToken: encryptToken(payload.access_token), tokenExpiry: newExpiresAt });

  return payload.access_token;
}
