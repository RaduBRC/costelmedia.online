/**
 * Whisper transcription (via Groq's OpenAI-compatible /audio/transcriptions
 * endpoint, same GROQ_API_KEY already used for the chat/tool-calling agent
 * — see groqAgent.ts) — the actual speech-to-text engine for what gets
 * transcribed on a live voice call.
 *
 * Deliberately NOT a replacement for Deepgram (deepgramStt.ts) — that
 * file's own header already documents why: Whisper's endpoint is a batch
 * (send-a-complete-clip, get-one-transcript) REST call, not a streaming
 * protocol, so it structurally cannot produce interim results or
 * real-time endpointing/barge-in signals. The two are used together
 * instead, each for what it's actually good at:
 *   - Deepgram stays wired up for real-time VAD — onSpeechStarted (barge-in)
 *     and onUtteranceEnd (turn-boundary detection) both need sub-second
 *     signals as audio arrives, which only a streaming connection can do.
 *   - Whisper (this file) does the actual transcription: once Deepgram
 *     signals an utterance is complete, the RAW AUDIO buffered for that
 *     utterance (not Deepgram's own transcript) is sent here for a
 *     higher-accuracy pass. voiceStreamServer.ts falls back to Deepgram's
 *     own transcript only if this returns null (Whisper unreachable, or
 *     the buffered audio was pure silence).
 *
 * Twilio Media Streams audio arrives as raw G.711 mu-law/8kHz/mono, which
 * Whisper's endpoint doesn't accept directly (it wants an actual audio
 * file) — mulawBufferToWav below decodes it to linear PCM16 and wraps it
 * in a minimal WAV container, entirely in-process, no new dependency.
 */

import type { Service, Tenant } from "../types/index.js";

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const WHISPER_MODEL = "whisper-large-v3-turbo";
const REQUEST_TIMEOUT_MS = 8000;
const SAMPLE_RATE_HZ = 8000; // Twilio Media Streams' fixed rate — matches deepgramStt.ts's own sample_rate param.

// ---------------------------------------------------------------------------
// Diacritics stripping
// ---------------------------------------------------------------------------

/**
 * Maps every Romanian diacritic to its plain-Latin base letter — both
 * Unicode forms real Romanian text shows up in: the correct
 * comma-below letters (ș U+0219, ț U+021B) AND the legacy
 * cedilla-below look-alikes (ş U+015F, ţ U+0163) that older fonts/
 * keyboards/systems produce and that read identically to a human but are
 * different codepoints — both must be stripped, or "ş" surviving because
 * only "ș" was checked for is exactly the kind of silent encoding bug
 * this whole request exists to avoid. Uppercase covered the same way.
 */
const DIACRITIC_MAP: Record<string, string> = {
  ă: "a",
  Ă: "A",
  â: "a",
  Â: "A",
  î: "i",
  Î: "I",
  ș: "s",
  Ș: "S",
  ş: "s",
  Ş: "S",
  ț: "t",
  Ț: "T",
  ţ: "t",
  Ţ: "T",
};

const DIACRITIC_RE = new RegExp(`[${Object.keys(DIACRITIC_MAP).join("")}]`, "g");

/**
 * Strips Romanian diacritics from `text`, replacing each with its plain
 * Latin base letter — applied to every Whisper transcript before it
 * reaches the LLM or gets saved to the database (see transcribeWithWhisper
 * below), per this integration's strict "no diacritics" requirement.
 * Whisper's own prompt (buildWhisperPrompt) asks it not to use them in
 * the first place, but that's a soft bias, not a guarantee — live testing
 * during this integration showed Whisper keeping diacritics on some
 * words ("Bună", "mâine") while dropping them on others in the exact
 * same transcript, so this function is the actual enforcement, not the
 * prompt.
 */
export function stripDiacritics(text: string): string {
  return text.replace(DIACRITIC_RE, (char) => DIACRITIC_MAP[char] ?? char);
}

// ---------------------------------------------------------------------------
// mu-law -> WAV (Whisper needs a real audio file, not a raw byte stream)
// ---------------------------------------------------------------------------

/**
 * Standard ITU-T G.711 mu-law decompression — one byte in, one 16-bit
 * linear PCM sample out. A well-known, unambiguous bit-manipulation
 * algorithm (the same one used by essentially every open-source mu-law
 * codec), not something specific to this app.
 */
function decodeMuLawSample(muLawByte: number): number {
  const MULAW_BIAS = 0x84;
  const inverted = ~muLawByte & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign !== 0 ? -sample : sample;
}

/** Decodes a full mu-law buffer to 16-bit linear PCM samples. */
function mulawBufferToPcm16(mulawBuffer: Buffer): Int16Array {
  const samples = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    samples[i] = decodeMuLawSample(mulawBuffer[i] as number);
  }
  return samples;
}

/** Wraps 16-bit mono PCM samples in a minimal 44-byte RIFF/WAVE header — the smallest valid .wav Whisper's endpoint will accept. */
function pcm16ToWavBuffer(samples: Int16Array, sampleRateHz: number): Buffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  buffer.writeUInt16LE(1, 20); // format = 1 (PCM, uncompressed)
  buffer.writeUInt16LE(1, 22); // channels = mono
  buffer.writeUInt32LE(sampleRateHz, 24);
  buffer.writeUInt32LE(sampleRateHz * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i] as number, 44 + i * bytesPerSample);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// RMS / silence gate
// ---------------------------------------------------------------------------

/**
 * Root-mean-square amplitude of a set of 16-bit PCM samples — the
 * standard way to measure a clip's actual loudness rather than eyeballing
 * raw byte values (which mu-law's own bit-packing makes meaningless to
 * threshold directly; decoding to real amplitude first, as
 * mulawBufferToPcm16 does, is what makes this measurement meaningful at
 * all). Ranges 0 (perfect digital silence) to ~32767 (theoretical max).
 */
export function computeRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sumOfSquares = 0;
  for (const sample of samples) {
    sumOfSquares += sample * sample;
  }
  return Math.sqrt(sumOfSquares / samples.length);
}

/**
 * Below this RMS, a clip is treated as silence/breath noise, not speech —
 * skipped before ever reaching Whisper (which otherwise reliably
 * hallucinates plausible-sounding phrases out of near-silent audio,
 * a well-documented Whisper failure mode, not a hypothetical one).
 * Empirically-reasonable starting point for phone-quality audio; override
 * via WHISPER_SILENCE_RMS_THRESHOLD without a code change if real call
 * audio needs a different cutoff.
 */
const DEFAULT_SILENCE_RMS_THRESHOLD = 300;

function silenceRmsThreshold(): number {
  const override = process.env["WHISPER_SILENCE_RMS_THRESHOLD"];
  const parsed = override ? Number(override) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SILENCE_RMS_THRESHOLD;
}

/** True if `mulawBuffer` is quiet enough to skip sending to Whisper entirely. */
export function isAudioSilent(mulawBuffer: Buffer): boolean {
  if (mulawBuffer.length === 0) return true;
  const rms = computeRms(mulawBufferToPcm16(mulawBuffer));
  return rms < silenceRmsThreshold();
}

// ---------------------------------------------------------------------------
// Dynamic prompt
// ---------------------------------------------------------------------------

/**
 * Whisper's `prompt` parameter biases vocabulary/style, not correctness —
 * it's a hint the model leans on for ambiguous audio, not an instruction
 * it strictly obeys (confirmed live during this integration: even with
 * this exact "no diacritics" instruction, Whisper still produced mixed
 * output). Still worth sending: naming the tenant and its real services
 * measurably improves recognition of business-specific terms and the
 * tenant's own name, which generic Whisper otherwise mishears often on
 * short phone utterances.
 */
export function buildWhisperPrompt(tenant: Tenant, services: Service[]): string {
  const serviceNames = services
    .slice(0, 8) // Keeps the prompt short — Whisper's prompt has a real token budget, and a long list dilutes the bias rather than strengthening it.
    .map((service) => service.name)
    .join(", ");
  return (
    "Aceasta este o conversatie in limba romana fara diacritice. Vorbitorul poate folosi regionalisme si " +
    "termeni specifici de afaceri precum: programare, calendar, serviciu, confirmare, pret" +
    `${tenant.name ? `, ${tenant.name}` : ""}${serviceNames ? `, ${serviceNames}` : ""}.`
  );
}

// ---------------------------------------------------------------------------
// The actual transcription call
// ---------------------------------------------------------------------------

/**
 * Transcribes one buffered Twilio utterance (raw mu-law/8kHz/mono audio)
 * via Groq's Whisper endpoint. Returns null — never throws — on any
 * failure (silence, missing key, network/API error, timeout): a
 * transcription miss should degrade the caller's turn (voiceStreamServer.ts
 * falls back to Deepgram's own transcript), not crash the call. Every
 * failure is still logged with enough detail to diagnose from server logs.
 */
export async function transcribeWithWhisper(mulawBuffer: Buffer, tenant: Tenant, services: Service[]): Promise<string | null> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) {
    console.error("[Whisper STT] Missing GROQ_API_KEY — cannot transcribe.");
    return null;
  }

  if (isAudioSilent(mulawBuffer)) {
    return null; // Not an error — silence/breath noise is the expected common case, not logged as a failure.
  }

  const wavBuffer = pcm16ToWavBuffer(mulawBufferToPcm16(mulawBuffer), SAMPLE_RATE_HZ);

  const formData = new FormData();
  // Buffer's underlying ArrayBufferLike isn't directly assignable to
  // BlobPart (which wants a concrete ArrayBuffer) under strict lib.dom
  // typing — a plain Uint8Array copy sidesteps the mismatch.
  formData.append("file", new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }), "utterance.wav");
  formData.append("model", WHISPER_MODEL);
  formData.append("language", "ro");
  // Forces strict, non-creative transcription — no sampling temperature
  // means no randomness in what Whisper decides it heard, which matters
  // most on the short, sometimes-ambiguous utterances a phone call
  // produces (a booking confirmation is the wrong place for a "creative"
  // guess at what the caller said).
  formData.append("temperature", "0");
  formData.append("prompt", buildWhisperPrompt(tenant, services));
  formData.append("response_format", "json");

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: timeoutController.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      console.error(`[Whisper STT] Groq transcription request failed (HTTP ${response.status}): ${errorBody}`);
      return null;
    }

    const payload = (await response.json()) as { text?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      return null; // A genuinely empty transcript (e.g. non-speech audio Whisper correctly declined to transcribe) — not an error.
    }

    return stripDiacritics(payload.text.trim());
  } catch (error) {
    if (timeoutController.signal.aborted) {
      console.error(`[Whisper STT] Groq transcription request did not complete within ${REQUEST_TIMEOUT_MS}ms.`);
    } else {
      console.error("[Whisper STT] Groq transcription request failed:", error instanceof Error ? error.message : error);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
