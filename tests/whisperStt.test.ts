/**
 * Unit tests for src/telephony/whisperStt.ts's pure pieces — diacritics
 * stripping, mu-law RMS/silence detection, and dynamic prompt building.
 * No network needed for any of these (transcribeWithWhisper's actual
 * Groq call was verified live during development — see the commit this
 * shipped in — but isn't re-exercised here, consistent with how this
 * suite treats every other real external API in this codebase).
 */
import { describe, expect, it } from "vitest";
import { buildWhisperPrompt, computeRms, isAudioSilent, stripDiacritics } from "../src/telephony/whisperStt.js";
import type { Service, Tenant } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// stripDiacritics
// ---------------------------------------------------------------------------

describe("stripDiacritics", () => {
  it("strips every standard Romanian diacritic (comma-below forms)", () => {
    expect(stripDiacritics("ă â î ș ț")).toBe("a a i s t");
    expect(stripDiacritics("Ă Â Î Ș Ț")).toBe("A A I S T");
  });

  it("strips the legacy cedilla-below look-alikes too, not just the correct comma-below forms", () => {
    // ş U+015F and ţ U+0163 — visually identical to ș/ț in many fonts but
    // different codepoints; real-world Romanian text (and some STT output)
    // uses both interchangeably.
    expect(stripDiacritics("ş ţ Ş Ţ")).toBe("s t S T");
  });

  it("cleans a realistic sentence end to end", () => {
    expect(stripDiacritics("Bună ziua, aș dori să confirm întâlnirea pentru mâine.")).toBe(
      "Buna ziua, as dori sa confirm intalnirea pentru maine.",
    );
  });

  it("leaves plain ASCII text completely unchanged", () => {
    const plain = "Programare confirmata pentru 20 august la ora 10.";
    expect(stripDiacritics(plain)).toBe(plain);
  });

  it("handles mixed correct/incorrect diacritics in the same word, as real Whisper output does", () => {
    // Observed live: Whisper kept diacritics on some words, dropped them
    // on others within the same transcript — this must clean both cases.
    expect(stripDiacritics("Bună, as dori o programare, va rog.")).toBe("Buna, as dori o programare, va rog.");
  });
});

// ---------------------------------------------------------------------------
// mu-law RMS / silence detection
// ---------------------------------------------------------------------------

/** Standard ITU-T G.711 mu-law encoding of a given 16-bit linear sample — the inverse of what mulawStt.ts decodes, used here only to build realistic test fixtures. */
function encodeMuLawSample(sample: number): number {
  const MULAW_BIAS = 0x84;
  const MULAW_MAX = 32635;
  let sign = 0;
  let value = sample;
  if (value < 0) {
    sign = 0x80;
    value = -value;
  }
  if (value > MULAW_MAX) value = MULAW_MAX;
  value += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  const byte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return byte;
}

function silentMulawBuffer(lengthBytes: number): Buffer {
  // 0xFF is the canonical mu-law "digital silence" byte (encodes to a
  // near-zero-amplitude sample) — what a real quiet phone line sends.
  return Buffer.alloc(lengthBytes, 0xff);
}

function loudMulawBuffer(lengthBytes: number): Buffer {
  // A simple alternating +/- full-scale tone — unambiguously "not silence"
  // regardless of exact threshold tuning.
  const buffer = Buffer.alloc(lengthBytes);
  for (let i = 0; i < lengthBytes; i++) {
    buffer[i] = encodeMuLawSample(i % 2 === 0 ? 20000 : -20000);
  }
  return buffer;
}

describe("computeRms", () => {
  it("returns 0 for an empty sample set", () => {
    expect(computeRms(new Int16Array(0))).toBe(0);
  });

  it("returns 0 for all-zero samples", () => {
    expect(computeRms(new Int16Array(100))).toBe(0);
  });

  it("returns the amplitude for a constant non-zero signal", () => {
    const samples = new Int16Array(10).fill(1000);
    expect(computeRms(samples)).toBeCloseTo(1000, 0);
  });
});

describe("isAudioSilent", () => {
  it("treats an empty buffer as silent", () => {
    expect(isAudioSilent(Buffer.alloc(0))).toBe(true);
  });

  it("treats a canonical mu-law silence buffer as silent", () => {
    expect(isAudioSilent(silentMulawBuffer(1600))).toBe(true);
  });

  it("treats a clearly loud buffer as not silent", () => {
    expect(isAudioSilent(loudMulawBuffer(1600))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildWhisperPrompt
// ---------------------------------------------------------------------------

const fixtureTenant: Tenant = {
  id: "tenant-1",
  ownerUserId: "owner-1",
  name: "Metro Dental Clinic",
  businessType: "clinic",
  googleCalendarId: "primary",
  timezone: "Europe/Bucharest",
  workingHours: { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  elevenlabsVoiceId: null,
  systemPromptOverride: null,
  greetingMessage: null,
  isActive: true,
  publicPhoneNumber: null,
  address: null,
  toneOfVoice: "friendly",
  plan: "starter",
  requiredBookingFields: null,
  sttStrategy: "deepgram_only",
};

function fixtureService(name: string): Service {
  return {
    id: name,
    tenantId: fixtureTenant.id,
    name,
    durationMinutes: 30,
    priceMinorUnits: 10000,
    currency: "RON",
    description: null,
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("buildWhisperPrompt", () => {
  it("includes the no-diacritics instruction and the tenant's name", () => {
    const prompt = buildWhisperPrompt(fixtureTenant, []);
    expect(prompt).toContain("fara diacritice");
    expect(prompt).toContain("Metro Dental Clinic");
  });

  it("includes real service names when present", () => {
    const prompt = buildWhisperPrompt(fixtureTenant, [fixtureService("Consultatie stomatologica"), fixtureService("Curatare dentara")]);
    expect(prompt).toContain("Consultatie stomatologica");
    expect(prompt).toContain("Curatare dentara");
  });

  it("caps the number of services included, keeping the prompt short", () => {
    const manyServices = Array.from({ length: 20 }, (_, i) => fixtureService(`Service ${i}`));
    const prompt = buildWhisperPrompt(fixtureTenant, manyServices);
    expect(prompt).toContain("Service 0");
    expect(prompt).not.toContain("Service 19");
  });

  it("never contains a diacritic character itself, matching what it asks the model to do", () => {
    const prompt = buildWhisperPrompt(fixtureTenant, [fixtureService("Consultatie")]);
    expect(prompt).not.toMatch(/[ăâîșțşţĂÂÎȘȚŞŢ]/);
  });
});
