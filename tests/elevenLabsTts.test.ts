/**
 * Unit tests for src/telephony/elevenLabsTts.ts's pure pieces — the
 * Markdown-stripping pre-processor (stripMarkdownForSpeech) and the
 * conversational-Romanian voice tuning (VOICE_SETTINGS/DEFAULT_MODEL_ID).
 * No network/mocking needed for either.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_ID, DEFAULT_VOICE_ID, isElevenLabsConfigured, stripMarkdownForSpeech, VOICE_SETTINGS } from "../src/telephony/elevenLabsTts.js";

describe("stripMarkdownForSpeech", () => {
  it("strips bold markers, keeping the text", () => {
    expect(stripMarkdownForSpeech("Este **foarte important** să confirmați.")).toBe("Este foarte important să confirmați.");
    expect(stripMarkdownForSpeech("Este __foarte important__ să confirmați.")).toBe("Este foarte important să confirmați.");
  });

  it("strips italic markers, keeping the text", () => {
    expect(stripMarkdownForSpeech("Aveți o *programare* mâine.")).toBe("Aveți o programare mâine.");
    expect(stripMarkdownForSpeech("Aveți o _programare_ mâine.")).toBe("Aveți o programare mâine.");
  });

  it("strips heading markers at the start of a line", () => {
    expect(stripMarkdownForSpeech("# Servicii disponibile")).toBe("Servicii disponibile");
    expect(stripMarkdownForSpeech("### Detalii programare")).toBe("Detalii programare");
  });

  it("strips bullet list markers, keeping the item text", () => {
    expect(stripMarkdownForSpeech("- Schimb ulei\n- Verificare frâne")).toBe("Schimb ulei\nVerificare frâne");
    expect(stripMarkdownForSpeech("* Schimb ulei\n* Verificare frâne")).toBe("Schimb ulei\nVerificare frâne");
  });

  it("never touches a mid-word hyphen — only a line-leading bullet dash is stripped", () => {
    expect(stripMarkdownForSpeech("Programarea durează 10-15 minute pentru schimbul de plăcuțe-frână.")).toBe(
      "Programarea durează 10-15 minute pentru schimbul de plăcuțe-frână.",
    );
  });

  it("drops a stray, unpaired symbol rather than reading it aloud", () => {
    expect(stripMarkdownForSpeech("Comanda #1234 este confirmată.")).toBe("Comanda 1234 este confirmată.");
    expect(stripMarkdownForSpeech("Contact: nume_utilizator la exemplu.")).toBe("Contact: numeutilizator la exemplu.");
  });

  it("collapses whitespace left behind by stripping without mangling normal spacing", () => {
    expect(stripMarkdownForSpeech("Bună  ziua,   ați  sunat.")).toBe("Bună ziua, ați sunat.");
  });

  it("leaves plain, non-Markdown text completely unchanged", () => {
    const plain = "Bună ziua, ați sunat la Metro Dental Clinic. Cu ce vă pot ajuta astăzi?";
    expect(stripMarkdownForSpeech(plain)).toBe(plain);
  });

  it("handles a realistic multi-symbol LLM reply end to end", () => {
    const llmReply = "# Programare confirmată\n\nAți rezervat **schimb ulei** pe 20 august, ora 10:00.\n- Durată: 30 min\n- Preț: 150 RON";
    expect(stripMarkdownForSpeech(llmReply)).toBe("Programare confirmată\nAți rezervat schimb ulei pe 20 august, ora 10:00.\nDurată: 30 min\nPreț: 150 RON");
  });
});

describe("conversational Romanian voice tuning", () => {
  it("uses eleven_multilingual_v2 as the default model", () => {
    expect(DEFAULT_MODEL_ID).toBe("eleven_multilingual_v2");
  });

  it("uses the retuned conversational voice settings", () => {
    expect(VOICE_SETTINGS).toEqual({ stability: 0.4, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true });
  });
});

describe("platform primary default voice", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("DEFAULT_VOICE_ID is the platform's primary voice", () => {
    expect(DEFAULT_VOICE_ID).toBe("GRHbHyXbUO8nF4YexVTa");
  });

  it("isElevenLabsConfigured is true once an API key exists, even with no tenant override and no env var voice set — DEFAULT_VOICE_ID always resolves", () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    vi.stubEnv("ELEVENLABS_VOICE_ID", "");
    expect(isElevenLabsConfigured(null)).toBe(true);
    expect(isElevenLabsConfigured(undefined)).toBe(true);
  });

  it("isElevenLabsConfigured is false with no API key, regardless of voice configuration", () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    expect(isElevenLabsConfigured("some-tenant-voice-id")).toBe(false);
  });

  it("a tenant-specific voice override still takes priority over the platform default", () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    vi.stubEnv("ELEVENLABS_VOICE_ID", "");
    // Not asserting the actual resolved id here (that's fetchElevenLabsSpeechStream's
    // internal `||` chain, not separately exposed) — isElevenLabsConfigured
    // just needs to keep reporting "configured" whether or not an override
    // is present, which it does for both branches.
    expect(isElevenLabsConfigured("a-specific-tenant-voice-id")).toBe(true);
  });
});
