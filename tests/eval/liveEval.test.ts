/**
 * The actual runner for the fixed eval set (liveEvalScenarios.ts) — the tool Radu
 * asked for to test a prompt/knowledge-base change against real model
 * behavior instead of judging "by eye". Deliberately NOT part of the
 * normal `npm test` safety net in spirit, even though it lives under
 * tests/**: unlike every other suite in this repo, this one makes REAL
 * Groq calls (real cost, real network, non-deterministic LLM output) —
 * see agentBookingFlow.test.ts's own header for why that suite mocks
 * fetch instead. This file mocks everything EXCEPT Groq (Supabase, Google
 * Calendar) for the same reason that file mocks everything: the goal here
 * is isolating "did the prompt/knowledge-base change break real model
 * behavior", not re-testing calendar/DB plumbing agentBookingFlow.test.ts
 * already covers.
 *
 * Guarded behind RUN_LIVE_EVAL=1 (checked before anything else runs) so:
 *   - `npm test` / CI / the hourly watchdog session never accidentally
 *     spends real Groq credits or fails on LLM non-determinism.
 *   - Running it for real is explicit: RUN_LIVE_EVAL=1 npx vitest run
 *     tests/eval/liveEval.test.ts  (needs a real GROQ_API_KEY in the
 *     environment — this file never touches or logs that key itself).
 *
 * A mismatch here means one of two things, and the reason string on the
 * result (see evalRubric.ts) plus the printed transcript are what tell
 * you which: the prompt/knowledge-base change genuinely broke behavior
 * (fix the prompt), or the scenario's expectedOutcome was wrong to begin
 * with (fix liveEvalScenarios.ts) — never treat a failing scenario as "flaky,
 * just re-run it" without reading why it disagreed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientProfile, Faq, Service, Slot, Tenant } from "../../src/types/index.js";
import { classifyConversationOutcome } from "../../src/agent/evalRubric.js";
import { EVAL_SCENARIOS } from "./liveEvalScenarios.js";
import type { EvalScenario } from "./liveEvalScenarios.js";

const RUN_LIVE_EVAL = process.env["RUN_LIVE_EVAL"] === "1" && !!process.env["GROQ_API_KEY"];

const getTenantById = vi.fn<() => Promise<Tenant | null>>();
const getOrCreateClientProfile = vi.fn<() => Promise<ClientProfile>>();
const updateClientToneProfile = vi.fn<() => Promise<ClientProfile>>();
const insertConversationLog = vi.fn<() => Promise<void>>();
const getAppointmentById = vi.fn<() => Promise<null>>();
const updateAppointmentStatus = vi.fn<() => Promise<never>>();
const listServices = vi.fn<() => Promise<Service[]>>().mockResolvedValue([]);
const listFaqs = vi.fn<() => Promise<Faq[]>>().mockResolvedValue([]);

vi.mock("../../src/db/supabase.js", () => ({
  getTenantById: (...args: unknown[]) => getTenantById(...(args as [])),
  getOrCreateClientProfile: (...args: unknown[]) => getOrCreateClientProfile(...(args as [])),
  updateClientToneProfile: (...args: unknown[]) => updateClientToneProfile(...(args as [])),
  insertConversationLog: (...args: unknown[]) => insertConversationLog(...(args as [])),
  getAppointmentById: (...args: unknown[]) => getAppointmentById(...(args as [])),
  updateAppointmentStatus: (...args: unknown[]) => updateAppointmentStatus(...(args as [])),
  listServices: (...args: unknown[]) => listServices(...(args as [])),
  listFaqs: (...args: unknown[]) => listFaqs(...(args as [])),
}));

let bookingCounter = 0;
const getAvailableSlots = vi.fn<() => Promise<Slot[]>>().mockResolvedValue([
  { start: "2026-09-01T10:00:00.000Z", end: "2026-09-01T10:30:00.000Z", available: true },
  { start: "2026-09-01T14:00:00.000Z", end: "2026-09-01T14:30:00.000Z", available: true },
]);
const bookSlot = vi.fn<() => Promise<{ appointmentId: string; eventId: string; startTime: string }>>().mockImplementation(() => {
  bookingCounter += 1;
  return Promise.resolve({ appointmentId: `eval-appt-${bookingCounter}`, eventId: `eval-evt-${bookingCounter}`, startTime: "2026-09-01T10:00:00.000Z" });
});
const deleteCalendarEvent = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

vi.mock("../../src/calendar/googleCalendarEngine.js", () => ({
  getAvailableSlots: (...args: unknown[]) => getAvailableSlots(...(args as [])),
  bookSlot: (...args: unknown[]) => bookSlot(...(args as [])),
  deleteCalendarEvent: (...args: unknown[]) => deleteCalendarEvent(...(args as [])),
}));

const { processClientMessage } = await import("../../src/agent/groqAgent.js");

const CLIENT_PHONE = "+40712345678";

function tenantFixtureFor(scenario: EvalScenario): Tenant {
  const base: Tenant = {
    id: `eval-${scenario.id}`,
    ownerUserId: "eval-owner",
    name: `Eval ${scenario.vertical} tenant`,
    businessType: scenario.vertical,
    googleCalendarId: "eval@example.com",
    timezone: "Europe/Bucharest",
    workingHours: {
      monday: { start: "09:00", end: "18:00" },
      tuesday: { start: "09:00", end: "18:00" },
      wednesday: { start: "09:00", end: "18:00" },
      thursday: { start: "09:00", end: "18:00" },
      friday: { start: "09:00", end: "18:00" },
      saturday: { start: "10:00", end: "14:00" },
      sunday: null,
    },
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
  };
  return { ...base, ...scenario.tenantOverrides };
}

function fixtureClientProfile(): ClientProfile {
  return {
    id: "eval-client",
    tenantId: "eval-tenant",
    phoneNumber: CLIENT_PHONE,
    fullName: null,
    formalityScore: 3,
    communicationStyle: "",
    notes: "",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}

beforeEach(() => {
  bookingCounter = 0;
  getTenantById.mockReset();
  getOrCreateClientProfile.mockReset().mockResolvedValue(fixtureClientProfile());
  updateClientToneProfile.mockReset().mockResolvedValue(fixtureClientProfile());
  insertConversationLog.mockReset().mockResolvedValue(undefined);
  getAppointmentById.mockReset().mockResolvedValue(null);
  updateAppointmentStatus.mockReset();
  listServices.mockReset().mockResolvedValue([]);
  listFaqs.mockReset().mockResolvedValue([]);
});

describe.skipIf(!RUN_LIVE_EVAL)("Live eval set (real Groq calls — RUN_LIVE_EVAL=1)", () => {
  for (const scenario of EVAL_SCENARIOS) {
    it(`[${scenario.vertical}] ${scenario.id}: ${scenario.description}`, async () => {
      const tenant = tenantFixtureFor(scenario);
      getTenantById.mockResolvedValue(tenant);

      const history: { role: "user" | "assistant"; content: string }[] = [];
      const agentReplies: string[] = [];
      let lastResult: Awaited<ReturnType<typeof processClientMessage>> | null = null;

      for (const turn of scenario.turns) {
        lastResult = await processClientMessage(tenant.id, CLIENT_PHONE, turn, "ai_chat", history);
        history.push({ role: "user", content: turn });
        history.push({ role: "assistant", content: lastResult.reply });
        agentReplies.push(lastResult.reply);
      }

      if (!lastResult) throw new Error(`Scenario ${scenario.id} has no turns.`);

      const classification = classifyConversationOutcome(
        {
          actionsTaken: lastResult.actionsTaken,
          createdAppointmentId: lastResult.createdAppointmentId,
          cancelledAppointmentId: lastResult.cancelledAppointmentId,
          reply: lastResult.reply,
        },
        agentReplies,
      );

      if (classification.outcome !== scenario.expectedOutcome) {
        console.error(
          `\n[EVAL MISMATCH] ${scenario.id} — expected "${scenario.expectedOutcome}", got "${classification.outcome}" (${classification.confidence} confidence: ${classification.reason})\n` +
            `Transcript:\n${scenario.turns.map((t, i) => `  Caller: ${t}\n  Agent: ${agentReplies[i]}`).join("\n")}\n`,
        );
      }
      expect(classification.outcome).toBe(scenario.expectedOutcome);
    });
  }
});

describe("Live eval set — sanity check (runs even without RUN_LIVE_EVAL)", () => {
  it("covers every business vertical with at least one scenario", async () => {
    const { EVAL_VERTICALS_COVERED } = await import("./liveEvalScenarios.js");
    const coveredInScenarios = new Set(EVAL_SCENARIOS.map((s) => s.vertical));
    for (const vertical of EVAL_VERTICALS_COVERED) {
      expect(coveredInScenarios.has(vertical)).toBe(true);
    }
  });

  it("gives every scenario a unique id", () => {
    const ids = EVAL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
