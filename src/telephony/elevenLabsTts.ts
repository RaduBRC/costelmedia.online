/**
 * ElevenLabs streaming TTS. Two consumers share the request-building
 * logic below (model, voice settings, language) but ask for different
 * output formats and consume the stream differently:
 *  - streamTextToSpeech: `output_format=ulaw_8000` — ElevenLabs added
 *    that format specifically for telephony integrations like this one,
 *    so the response body is already Twilio-ready mulaw/8kHz with no
 *    transcoding step. Forwards chunks as base64 over the Twilio Media
 *    Streams WebSocket (voiceStreamServer.ts).
 *  - src/api/routes/tts.ts: `output_format=mp3_44100_128` — browser-
 *    playable, for the dashboard's Voice Call Simulator. Pipes the raw
 *    bytes straight through as an HTTP response instead.
 * Both go through fetchElevenLabsSpeechStream so a tuning change (model,
 * stability, etc.) can't drift between the phone pipeline and the
 * in-dashboard simulator by only being made in one place.
 *
 * ElevenLabs' `/stream` endpoint sends audio progressively as it's
 * generated (lower time-to-first-byte) rather than waiting for the whole
 * clip — chosen over Google TTS for that reason, since the telephony path
 * has a < 800ms round-trip target a "generate everything, then send" call
 * would blow before any audio could start playing.
 *
 * Model: `eleven_multilingual_v2` — ElevenLabs' highest-quality
 * general-purpose model (their Turbo/Flash variants trade quality for
 * lower latency instead), and the one they explicitly support Romanian
 * on. This *does* sit in tension with the telephony path's < 800ms
 * budget — multilingual_v2 is measurably slower to first-byte than
 * turbo_v2_5 was. That tradeoff is deliberate here (quality was
 * explicitly requested over speed); if voice latency becomes the
 * bottleneck in practice, the ELEVENLABS_MODEL_ID env var overrides this
 * without a code change.
 *
 * Pitch/rate: ElevenLabs' API has no direct pitch or speech-rate
 * parameters (unlike the browser's SpeechSynthesis, which does — see
 * VoiceCallSimulator.tsx). The closest available levers are
 * `voice_settings.stability` (lower = more expressive/variable, higher =
 * calmer/more consistent) and `.style` (style exaggeration, 0-1) below;
 * actual pitch is a property of which ELEVENLABS_VOICE_ID is configured,
 * not something this code can adjust per-request.
 *
 * Timeout: every request gets a hard REQUEST_TIMEOUT_MS ceiling via an
 * internal AbortController. Before this existed, a hung upstream request
 * (ElevenLabs not responding, a stalled connection) meant the returned
 * promise never settled — not "returns an error", genuinely never
 * resolves or rejects — which every awaiting caller (the /api/tts route,
 * the browser's fetch to it, VoiceCallSimulator's speak()) would then
 * also hang on forever. That's indistinguishable from a frozen UI even
 * though no synchronous code is actually blocking anything.
 */

const REQUEST_TIMEOUT_MS = 5000;

export const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

// stability up from ElevenLabs' own default: fewer take-to-take swings in
// delivery reads as calmer and more composed. style kept low (not 0, some
// warmth) rather than high/dramatic — same "calm, friendly" target, not
// an animated/theatrical read.
export const VOICE_SETTINGS = { stability: 0.55, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true };

/** Thrown when neither a tenant-specific nor the env var default voice/key is available. Distinct from ElevenLabsRequestError so callers can return a fast, specific "not configured" response instead of a generic failure. */
export class ElevenLabsNotConfiguredError extends Error {}

/** Thrown when the request didn't complete within REQUEST_TIMEOUT_MS — distinct from a caller-initiated abort (barge-in), which is not an error at all; see fetchElevenLabsSpeechStream's own abort-source check. */
export class ElevenLabsTimeoutError extends Error {}

/** Thrown when ElevenLabs responded but with a non-2xx status (bad key, quota/plan restriction, outage, ...). */
export class ElevenLabsRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** One voice as returned by GET /v1/voices — trimmed to what the Settings voice-selector dropdown needs (id, display name, and a short preview clip URL ElevenLabs hosts for most stock/professional voices). */
export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  previewUrl: string | null;
  category: string | null;
}

/**
 * Real call to GET /v1/voices — backs GET /api/tenants/:tenantId/voices
 * (src/api/routes/tenantSettings.ts), which is what /admin/settings'
 * Voice Selector renders. Not cached: the voice list changes rarely
 * enough, and this endpoint is only hit when a staff member opens
 * Settings, that a few-hundred-ms round trip isn't worth the staleness
 * risk of a cache.
 */
export async function listElevenLabsVoices(): Promise<ElevenLabsVoice[]> {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) {
    throw new ElevenLabsNotConfiguredError("Missing ELEVENLABS_API_KEY.");
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
      signal: timeoutController.signal,
    });
  } catch (error) {
    if (timeoutController.signal.aborted) {
      throw new ElevenLabsTimeoutError(`ElevenLabs voices request did not complete within ${REQUEST_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new ElevenLabsRequestError(`ElevenLabs voices request failed (${response.status}): ${errorBody}`, response.status);
  }

  const payload = (await response.json()) as {
    voices?: { voice_id: string; name: string; preview_url?: string | null; category?: string | null }[];
  };

  return (payload.voices ?? []).map((voice) => ({
    voiceId: voice.voice_id,
    name: voice.name,
    previewUrl: voice.preview_url ?? null,
    category: voice.category ?? null,
  }));
}

function resolveModelId(): string {
  // `||`, not `??`: an env var present but set to "" (e.g. a .env
  // template line left blank rather than omitted) must fall back too,
  // not send ElevenLabs an empty model_id.
  return process.env["ELEVENLABS_MODEL_ID"] || DEFAULT_MODEL_ID;
}

/**
 * Automatic fallback model when the primary (resolveModelId — normally
 * eleven_multilingual_v2) is rejected as unusable, e.g. "model not
 * available on your plan" or a similar bad-request response tied to the
 * *model* rather than the account/quota. Turbo trades some quality for
 * being ElevenLabs' most broadly-available model, so it's the right
 * "at least get audio out" fallback rather than failing the whole request.
 */
const FALLBACK_MODEL_ID = "eleven_turbo_v2_5";

/** Status codes worth retrying with FALLBACK_MODEL_ID — a model/parameter problem, not auth (401) or quota (429), which swapping models can't fix. */
const MODEL_FALLBACK_RETRYABLE_STATUSES = new Set([400, 422]);

/**
 * Fast, no-network-call check for whether a TTS request would even have a
 * chance of succeeding — API key present, and a voice ID available from
 * either the tenant-specific override or the env var default. Meant to be
 * called *before* attempting a request, so "not configured" fails
 * immediately instead of behind a network round-trip that was never
 * going to work.
 */
export function isElevenLabsConfigured(voiceIdOverride?: string | null): boolean {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  const voiceId = voiceIdOverride || process.env["ELEVENLABS_VOICE_ID"];
  return !!(apiKey && voiceId);
}

/**
 * One-time boot log (called from src/server/index.ts's main(), after the
 * dotenv/config import has had a chance to populate process.env) —
 * confirms the two ElevenLabs env vars are actually visible to this
 * process without ever printing the secret itself. This is a presence/
 * shape check only: a key that's present but revoked, wrong-plan, or
 * missing a permission scope still passes this (and can only be caught by
 * an actual request — see ELEVENLABS_FAILED in src/api/routes/tts.ts, or
 * `node scripts/test-elevenlabs.js`).
 */
export function logElevenLabsConfigSanityCheck(): void {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  const voiceId = process.env["ELEVENLABS_VOICE_ID"];

  const keySummary = apiKey ? `Yes (length: ${apiKey.length})` : "No — TTS will fail with MISSING_KEYS until this is set.";
  // First 6 chars only — enough to eyeball "is this the key I think it
  // is" against the ElevenLabs dashboard without it being usable on its
  // own; voice IDs aren't secret (they're visible in ElevenLabs URLs/API
  // responses) so this one is safe to print in full instead.
  const keyPreview = apiKey ? `${apiKey.slice(0, 6)}…` : "n/a";
  const voiceSummary = voiceId ?? "No — falls back to nothing; tenant-specific elevenlabsVoiceId is still checked per-request.";

  console.log(`[ElevenLabs Config] API Key Present: ${keySummary}${apiKey ? ` (${keyPreview})` : ""}`);
  console.log(`[ElevenLabs Config] Voice ID (env default): ${voiceSummary}`);
}

/**
 * Makes the actual ElevenLabs streaming TTS request and returns the raw
 * Response once headers arrive — the body is *not* consumed here, so
 * callers can handle the stream however suits them (chunk-forwarding vs.
 * piping straight through).
 *
 * `voiceIdOverride` lets a caller request a specific tenant's own voice
 * (tenants.elevenlabs_voice_id) instead of the platform-wide
 * ELEVENLABS_VOICE_ID default. A blank override (empty string, or a
 * tenant row with the column unset) falls back to the env var default,
 * same `||`-not-`??` reasoning as resolveModelId above.
 *
 * `externalSignal`, if given, is combined with the internal timeout — an
 * abort via `externalSignal` (e.g. streamTextToSpeech's barge-in) is
 * rethrown as-is for the caller's own `signal.aborted` check to handle;
 * an abort from the internal timeout instead throws ElevenLabsTimeoutError.
 */
type ResponseWithBody = Response & { body: ReadableStream<Uint8Array> };

/** One HTTP attempt against the streaming TTS endpoint with a specific model — no retry logic here, that lives in fetchElevenLabsSpeechStream below. */
async function requestElevenLabsSpeechStream(
  text: string,
  outputFormat: string,
  voiceId: string,
  apiKey: string,
  modelId: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(outputFormat)}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: modelId,
      // ISO 639-1, not a BCP-47 locale tag (so "ro", not "ro-RO") — pins
      // the language explicitly rather than relying on multilingual_v2's
      // auto-detection, which matters most on short utterances where
      // auto-detection has the least text to go on.
      language_code: "ro",
      voice_settings: VOICE_SETTINGS,
    }),
    signal,
  });
}

export async function fetchElevenLabsSpeechStream(
  text: string,
  outputFormat: string,
  voiceIdOverride?: string | null,
  externalSignal?: AbortSignal,
): Promise<ResponseWithBody> {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  const voiceId = voiceIdOverride || process.env["ELEVENLABS_VOICE_ID"];
  if (!apiKey || !voiceId) {
    throw new ElevenLabsNotConfiguredError(
      "Missing ELEVENLABS_API_KEY, or no ELEVENLABS_VOICE_ID configured (neither tenant-specific nor the env var default).",
    );
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutController.signal]) : timeoutController.signal;

  const primaryModelId = resolveModelId();

  let response: Response;
  try {
    response = await requestElevenLabsSpeechStream(text, outputFormat, voiceId, apiKey, primaryModelId, signal);

    // A model/parameter-shaped rejection (not auth, not quota) on the
    // primary model gets exactly one retry against FALLBACK_MODEL_ID —
    // e.g. eleven_multilingual_v2 isn't enabled on this account's plan
    // but eleven_turbo_v2_5 is. Skipped if the primary model already *was*
    // the fallback (env override set it explicitly), so this can't loop.
    if (!response.ok && MODEL_FALLBACK_RETRYABLE_STATUSES.has(response.status) && primaryModelId !== FALLBACK_MODEL_ID) {
      const primaryErrorBody = await response.text().catch(() => "");
      console.warn(
        `[ElevenLabs API] Model "${primaryModelId}" rejected (HTTP ${response.status}: ${primaryErrorBody}) — retrying once with fallback model "${FALLBACK_MODEL_ID}".`,
      );
      response = await requestElevenLabsSpeechStream(text, outputFormat, voiceId, apiKey, FALLBACK_MODEL_ID, signal);
    }
  } catch (error) {
    if (externalSignal?.aborted) {
      throw error; // Caller's own abort (barge-in) — not this function's concern; the caller checks signal.aborted itself.
    }
    if (timeoutController.signal.aborted) {
      throw new ElevenLabsTimeoutError(`ElevenLabs TTS request did not complete within ${REQUEST_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok || !response.body) {
    const errorBody = await response.text().catch(() => "");
    throw new ElevenLabsRequestError(`ElevenLabs TTS request failed (${response.status}): ${errorBody}`, response.status);
  }
  return response as ResponseWithBody;
}

/**
 * Streams synthesized speech for `text`, invoking `onChunk` with each
 * base64-encoded mulaw chunk as it arrives (ready to drop straight into a
 * Twilio Media Streams "media" event). Resolves once the stream ends
 * normally *or* `signal` aborts it (barge-in) — an abort is not treated as
 * an error, since it's the expected, common case here. `voiceId` is the
 * calling tenant's own ElevenLabs voice (see fetchElevenLabsSpeechStream).
 */
export async function streamTextToSpeech(
  text: string,
  onChunk: (base64UlawChunk: string) => void,
  signal: AbortSignal,
  voiceId?: string | null,
): Promise<void> {
  let response: ResponseWithBody;
  try {
    response = await fetchElevenLabsSpeechStream(text, "ulaw_8000", voiceId, signal);
  } catch (error) {
    if (signal.aborted) {
      return; // Barge-in cut this off before/during the request — expected, not an error.
    }
    throw error;
  }

  // Node's ambient fetch types don't always propagate the Uint8Array
  // generic through ReadableStream cleanly — pin it explicitly.
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      if (result.value.length > 0) {
        onChunk(Buffer.from(result.value).toString("base64"));
      }
    }
  } catch (error) {
    if (signal.aborted) {
      return; // Barge-in aborted the read mid-stream — expected.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
