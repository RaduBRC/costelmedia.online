/** Pushes ActivityKit Live Activity updates (Lock Screen / Dynamic Island) over APNs. */
import { connect as connectHttp2, constants as http2Constants } from "node:http2";
import { createSign } from "node:crypto";
import { base64UrlEncode } from "../utils/base64Url.js";
import type { IOSLiveActivityState } from "./stickyPayloads.js";

export type LiveActivityEvent = "start" | "update" | "end";

export interface ApnsLiveActivityPayload {
  aps: {
    timestamp: number;
    event: LiveActivityEvent;
    "content-state": IOSLiveActivityState;
    "stale-date"?: number;
  };
}

export function buildApnsEnvelope(state: IOSLiveActivityState, event: LiveActivityEvent): ApnsLiveActivityPayload {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    aps: {
      timestamp: nowSeconds,
      event,
      "content-state": state,
      ...(event === "end" ? {} : { "stale-date": state.appointmentTimestamp }),
    },
  };
}

interface ApnsTokenCacheEntry {
  token: string;
  issuedAtEpochSeconds: number;
}

let apnsTokenCache: ApnsTokenCacheEntry | null = null;
const APNS_TOKEN_MAX_AGE_SECONDS = 20 * 60;

function loadApnsCredentials(): { keyId: string; teamId: string; bundleId: string; privateKey: string } {
  const keyId = process.env["APNS_KEY_ID"];
  const teamId = process.env["APNS_TEAM_ID"];
  const bundleId = process.env["APNS_BUNDLE_ID"];
  const rawPrivateKey = process.env["APNS_PRIVATE_KEY"];

  if (!keyId || !teamId || !bundleId || !rawPrivateKey) {
    throw new Error("Missing one of APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_PRIVATE_KEY environment variables.");
  }
  return { keyId, teamId, bundleId, privateKey: rawPrivateKey.replace(/\\n/g, "\n") };
}

/** Signs a short-lived ES256 provider authentication token for APNs (RFC 7519, cached ~20 min). */
function getApnsAuthToken(): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (apnsTokenCache && nowSeconds - apnsTokenCache.issuedAtEpochSeconds < APNS_TOKEN_MAX_AGE_SECONDS) {
    return apnsTokenCache.token;
  }

  const credentials = loadApnsCredentials();
  const header = base64UrlEncode(JSON.stringify({ alg: "ES256", kid: credentials.keyId }));
  const claims = base64UrlEncode(JSON.stringify({ iss: credentials.teamId, iat: nowSeconds }));

  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  // APNs expects the raw (r || s) JOSE signature format, not ASN.1 DER.
  const signature = base64UrlEncode(signer.sign({ key: credentials.privateKey, dsaEncoding: "ieee-p1363" }));

  const token = `${header}.${claims}.${signature}`;
  apnsTokenCache = { token, issuedAtEpochSeconds: nowSeconds };
  return token;
}

/** Sends a Live Activity start/update/end event to a single device over APNs (HTTP/2). */
export async function sendIosLiveActivityUpdate(
  deviceToken: string,
  state: IOSLiveActivityState,
  event: LiveActivityEvent = "update",
): Promise<void> {
  const credentials = loadApnsCredentials();
  const useSandbox = process.env["APNS_USE_SANDBOX"] === "true";
  const authority = useSandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const authToken = getApnsAuthToken();
  const payload = buildApnsEnvelope(state, event);

  await new Promise<void>((resolve, reject) => {
    const client = connectHttp2(authority);
    client.on("error", (error) => reject(error));

    const request = client.request({
      [http2Constants.HTTP2_HEADER_METHOD]: "POST",
      [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
      authorization: `bearer ${authToken}`,
      "apns-topic": `${credentials.bundleId}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
    });

    let responseBody = "";
    let statusCode = 0;

    request.on("response", (headers) => {
      statusCode = Number(headers[http2Constants.HTTP2_HEADER_STATUS] ?? 0);
    });
    request.on("data", (chunk: Buffer) => {
      responseBody += chunk.toString("utf8");
    });
    request.on("end", () => {
      client.close();
      if (statusCode >= 200 && statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`APNs push failed (${statusCode}): ${responseBody}`));
      }
    });
    request.on("error", (error) => {
      client.close();
      reject(error);
    });

    request.end(JSON.stringify(payload));
  });
}
