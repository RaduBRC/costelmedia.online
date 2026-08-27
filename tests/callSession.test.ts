/**
 * Unit tests for src/telephony/callSession.ts's sustained-frustration
 * escalation tracking (recordToneSignal) — the logic behind
 * 023_voice_improvements.sql's call_transcripts.needs_follow_up column.
 * db/supabase.ts is mocked at the module boundary (same pattern as
 * agentBookingFlow.test.ts) since createCallSession/endCallSession make
 * real Supabase calls this suite never wants to hit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientProfile } from "../src/types/index.js";

const getOrCreateClientProfile = vi.fn<() => Promise<ClientProfile>>();
const insertCallTranscript = vi.fn<() => Promise<unknown>>();
const insertUsageEvent = vi.fn<() => Promise<void>>();

vi.mock("../src/db/supabase.js", () => ({
  getOrCreateClientProfile: (...args: unknown[]) => getOrCreateClientProfile(...(args as [])),
  insertCallTranscript: (...args: unknown[]) => insertCallTranscript(...(args as [])),
  insertUsageEvent: (...args: unknown[]) => insertUsageEvent(...(args as [])),
}));

const { createCallSession, endCallSession, recordToneSignal, appendTranscriptTurn } = await import("../src/telephony/callSession.js");

const CLIENT_PROFILE: ClientProfile = {
  id: "client-1",
  tenantId: "tenant-1",
  phoneNumber: "+15555550123",
  fullName: null,
  formalityScore: 3,
  communicationStyle: "",
  notes: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function neutralTone(): { urgency: 3; formality: 3; sentiment: "neutral"; toneNote: "" } {
  return { urgency: 3, formality: 3, sentiment: "neutral", toneNote: "" };
}

function frustratedTone(): { urgency: 3; formality: 3; sentiment: "frustrated"; toneNote: "" } {
  return { urgency: 3, formality: 3, sentiment: "frustrated", toneNote: "" };
}

beforeEach(() => {
  getOrCreateClientProfile.mockReset().mockResolvedValue(CLIENT_PROFILE);
  insertCallTranscript.mockReset().mockResolvedValue(undefined);
  insertUsageEvent.mockReset().mockResolvedValue(undefined);
});

describe("recordToneSignal", () => {
  it("does nothing for an unknown streamSid", () => {
    expect(recordToneSignal("does-not-exist", frustratedTone())).toBe(false);
  });

  it("returns false for a single frustrated turn — one bad turn is normal conversation noise", async () => {
    const session = await createCallSession({ callSid: "CA1", streamSid: "stream-1", tenantId: "tenant-1", callerPhone: "+15555550123" });
    expect(recordToneSignal(session.streamSid, frustratedTone())).toBe(false);
  });

  it("returns true exactly once, on the turn that crosses the threshold (2 consecutive)", async () => {
    const session = await createCallSession({ callSid: "CA2", streamSid: "stream-2", tenantId: "tenant-1", callerPhone: "+15555550123" });
    expect(recordToneSignal(session.streamSid, frustratedTone())).toBe(false); // 1st frustrated turn
    expect(recordToneSignal(session.streamSid, frustratedTone())).toBe(true); // 2nd — crosses threshold
    expect(recordToneSignal(session.streamSid, frustratedTone())).toBe(false); // 3rd — already escalated, not repeated
  });

  it("resets the streak on a non-frustrated turn — sustained means consecutive", async () => {
    const session = await createCallSession({ callSid: "CA3", streamSid: "stream-3", tenantId: "tenant-1", callerPhone: "+15555550123" });
    expect(recordToneSignal(session.streamSid, frustratedTone())).toBe(false);
    expect(recordToneSignal(session.streamSid, neutralTone())).toBe(false); // resets the streak
    expect(recordToneSignal(session.streamSid, frustratedTone())).toBe(false); // back to 1, not 2 — must not escalate yet
  });

  it("treats negative-with-high-urgency as frustrated, but negative-alone as not", async () => {
    const session = await createCallSession({ callSid: "CA4", streamSid: "stream-4", tenantId: "tenant-1", callerPhone: "+15555550123" });
    // Negative but calm (low urgency) twice — should never escalate.
    expect(recordToneSignal(session.streamSid, { urgency: 2, formality: 3, sentiment: "negative", toneNote: "" })).toBe(false);
    expect(recordToneSignal(session.streamSid, { urgency: 2, formality: 3, sentiment: "negative", toneNote: "" })).toBe(false);
    // Negative AND urgent, twice — should escalate on the second.
    expect(recordToneSignal(session.streamSid, { urgency: 5, formality: 3, sentiment: "negative", toneNote: "" })).toBe(false);
    expect(recordToneSignal(session.streamSid, { urgency: 5, formality: 3, sentiment: "negative", toneNote: "" })).toBe(true);
  });

  it("persists needs_follow_up: true on the call transcript once escalated", async () => {
    const session = await createCallSession({ callSid: "CA5", streamSid: "stream-5", tenantId: "tenant-1", callerPhone: "+15555550123" });
    appendTranscriptTurn(session.streamSid, "caller", "Nu ma poate ajuta nimeni?!");
    recordToneSignal(session.streamSid, frustratedTone());
    recordToneSignal(session.streamSid, frustratedTone());

    await endCallSession(session.streamSid);

    expect(insertCallTranscript).toHaveBeenCalledWith(expect.objectContaining({ needsFollowUp: true }));
  });

  it("persists needs_follow_up: false when the call never escalated", async () => {
    const session = await createCallSession({ callSid: "CA6", streamSid: "stream-6", tenantId: "tenant-1", callerPhone: "+15555550123" });
    appendTranscriptTurn(session.streamSid, "caller", "Bună, aș dori o programare.");
    recordToneSignal(session.streamSid, neutralTone());

    await endCallSession(session.streamSid);

    expect(insertCallTranscript).toHaveBeenCalledWith(expect.objectContaining({ needsFollowUp: false }));
  });
});
