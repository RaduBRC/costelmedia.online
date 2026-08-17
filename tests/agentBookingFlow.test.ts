/**
 * End-to-end simulation of the agent's booking flow. "End to end" here
 * means through the full orchestration in src/agent/groqAgent.ts — tone
 * assessment, the Groq function-calling loop, and tool execution — with
 * Groq itself (raw `fetch`), the Google Calendar engine, and the Supabase
 * data layer mocked at their module boundaries. That's the right seam:
 * it exercises all of groqAgent's real logic (including the prompt
 * actually sent to Groq) without hitting any network or requiring live
 * credentials.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Appointment, BookingConfirmation, ClientProfile, Faq, Service, Slot, Tenant } from "../src/types/index.js";

const getTenantById = vi.fn<() => Promise<Tenant | null>>();
const getOrCreateClientProfile = vi.fn<() => Promise<ClientProfile>>();
const updateClientToneProfile = vi.fn<() => Promise<ClientProfile>>();
const insertConversationLog = vi.fn<() => Promise<void>>();
const getAppointmentById = vi.fn<() => Promise<Appointment | null>>();
const updateAppointmentStatus = vi.fn<() => Promise<Appointment>>();
// Defaults to empty (no services configured) — formatActiveServicesList
// (promptBuilder.ts) handles that case explicitly; individual tests
// override via listServices.mockResolvedValueOnce(...) where the
// services list actually matters to what's being asserted.
const listServices = vi.fn<() => Promise<Service[]>>().mockResolvedValue([]);
// Same defaulting reasoning as listServices — formatFaqs (promptBuilder.ts)
// handles the empty case by omitting the FAQ block entirely.
const listFaqs = vi.fn<() => Promise<Faq[]>>().mockResolvedValue([]);

vi.mock("../src/db/supabase.js", () => ({
  getTenantById: (...args: unknown[]) => getTenantById(...(args as [])),
  getOrCreateClientProfile: (...args: unknown[]) => getOrCreateClientProfile(...(args as [])),
  updateClientToneProfile: (...args: unknown[]) => updateClientToneProfile(...(args as [])),
  insertConversationLog: (...args: unknown[]) => insertConversationLog(...(args as [])),
  getAppointmentById: (...args: unknown[]) => getAppointmentById(...(args as [])),
  updateAppointmentStatus: (...args: unknown[]) => updateAppointmentStatus(...(args as [])),
  listServices: (...args: unknown[]) => listServices(...(args as [])),
  listFaqs: (...args: unknown[]) => listFaqs(...(args as [])),
}));

const getAvailableSlots = vi.fn<() => Promise<Slot[]>>();
const bookSlot = vi.fn<() => Promise<BookingConfirmation>>();
const deleteCalendarEvent = vi.fn<() => Promise<void>>();

vi.mock("../src/calendar/googleCalendarEngine.js", () => ({
  getAvailableSlots: (...args: unknown[]) => getAvailableSlots(...(args as [])),
  bookSlot: (...args: unknown[]) => bookSlot(...(args as [])),
  deleteCalendarEvent: (...args: unknown[]) => deleteCalendarEvent(...(args as [])),
}));

// Imported after the mocks above so groqAgent picks up the mocked modules.
const { processClientMessage } = await import("../src/agent/groqAgent.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_ID = "22222222-2222-2222-2222-222222222222";
const CLIENT_PHONE = "+15555550123";

const fixtureTenant: Tenant = {
  id: TENANT_ID,
  ownerUserId: "33333333-3333-3333-3333-333333333333",
  name: "Bright Smile Dental",
  businessType: "clinic",
  googleCalendarId: "clinic@example.com",
  timezone: "America/New_York",
  workingHours: {
    monday: { start: "09:00", end: "17:00" },
    tuesday: { start: "09:00", end: "17:00" },
    wednesday: { start: "09:00", end: "17:00" },
    thursday: { start: "09:00", end: "17:00" },
    friday: { start: "09:00", end: "17:00" },
    saturday: null,
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
};

function fixtureClientProfile(overrides: Partial<ClientProfile> = {}): ClientProfile {
  return {
    id: CLIENT_ID,
    tenantId: TENANT_ID,
    phoneNumber: CLIENT_PHONE,
    fullName: null,
    formalityScore: 3,
    communicationStyle: "",
    notes: "",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Groq `fetch` mock: a FIFO queue of canned responses, one per expected call.
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function toneResponse(tone: { urgency: number; formality: number; sentiment: string; toneNote: string }): Response {
  return jsonResponse({
    choices: [{ message: { role: "assistant", content: JSON.stringify(tone) }, finish_reason: "stop" }],
  });
}

function toolCallResponse(toolCalls: { name: string; args: Record<string, unknown> }[]): Response {
  return jsonResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((call, index) => ({
            id: `call_${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
  });
}

function textResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
}

let fetchQueue: Response[] = [];
let capturedRequestBodies: Record<string, unknown>[] = [];

beforeEach(() => {
  process.env["GROQ_API_KEY"] = "test-key";
  fetchQueue = [];
  capturedRequestBodies = [];

  const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body && typeof init.body === "string") {
      capturedRequestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    const next = fetchQueue.shift();
    if (!next) {
      throw new Error("Test fetch queue exhausted — more Groq calls happened than the test expected.");
    }
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);

  getTenantById.mockReset().mockResolvedValue(fixtureTenant);
  getOrCreateClientProfile.mockReset().mockResolvedValue(fixtureClientProfile());
  updateClientToneProfile.mockReset().mockResolvedValue(fixtureClientProfile());
  insertConversationLog.mockReset().mockResolvedValue(undefined);
  getAppointmentById.mockReset();
  updateAppointmentStatus.mockReset();

  getAvailableSlots.mockReset();
  bookSlot.mockReset();
  deleteCalendarEvent.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Scenario A — check availability, then book the chosen slot
// ---------------------------------------------------------------------------

describe("Scenario A: dentist appointment booking flow", () => {
  it("checks availability and offers slots for a same-day request", async () => {
    fetchQueue.push(
      toneResponse({ urgency: 2, formality: 3, sentiment: "neutral", toneNote: "Relaxed, planning ahead." }),
      toolCallResponse([{ name: "check_available_slots", args: { date: "2026-08-16", service_type: "dentist checkup", duration_minutes: 30 } }]),
      textResponse("We have 2:00 PM and 3:00 PM open tomorrow for a dentist checkup — which works better for you?"),
    );
    getAvailableSlots.mockResolvedValue([
      { start: "2026-08-16T18:00:00.000Z", end: "2026-08-16T18:30:00.000Z", available: true },
      { start: "2026-08-16T19:00:00.000Z", end: "2026-08-16T19:30:00.000Z", available: true },
    ]);

    const result = await processClientMessage(TENANT_ID, CLIENT_PHONE, "Hi, I need a dentist appointment tomorrow afternoon.");

    expect(getAvailableSlots).toHaveBeenCalledWith(TENANT_ID, "2026-08-16", 30);
    expect(result.actionsTaken).toEqual(["checked_available_slots"]);
    expect(result.reply).toContain("2:00 PM");
    expect(result.toneAssessment).toEqual({ urgency: 2, formality: 3, sentiment: "neutral", toneNote: "Relaxed, planning ahead." });
  });

  it("books the slot the client picks", async () => {
    fetchQueue.push(
      toneResponse({ urgency: 2, formality: 3, sentiment: "positive", toneNote: "Confirming their choice." }),
      toolCallResponse([
        {
          name: "create_appointment",
          args: {
            client_name: "Jane Doe",
            phone: CLIENT_PHONE,
            service_type: "dentist checkup",
            datetime: "2026-08-16T18:00:00.000Z",
            duration_minutes: 30,
          },
        },
      ]),
      textResponse("You're all set for 2:00 PM tomorrow! See you then."),
    );
    bookSlot.mockResolvedValue({ appointmentId: "appt_123", eventId: "evt_123", startTime: "2026-08-16T18:00:00.000Z" });

    const result = await processClientMessage(TENANT_ID, CLIENT_PHONE, "2pm works, book it under Jane Doe please.");

    expect(bookSlot).toHaveBeenCalledWith(TENANT_ID, {
      phoneNumber: CLIENT_PHONE,
      fullName: "Jane Doe",
      serviceType: "dentist checkup",
      startTime: "2026-08-16T18:00:00.000Z",
      durationMinutes: 30,
      bookingChannel: "ai_chat",
    });
    expect(result.actionsTaken).toEqual(["created_appointment"]);
    expect(result.reply).toContain("2:00 PM");
    expect(result.createdAppointmentId).toBe("appt_123");
  });
});

// ---------------------------------------------------------------------------
// Scenario B — urgent/rude message: tone adapts, agent books immediately
// ---------------------------------------------------------------------------

describe("Scenario B: urgent message adapts tone and books immediately", () => {
  it("detects urgency 5, feeds it into the prompt, and books without extra back-and-forth", async () => {
    fetchQueue.push(
      toneResponse({ urgency: 5, formality: 2, sentiment: "frustrated", toneNote: "Demanding immediate action." }),
      toolCallResponse([{ name: "check_available_slots", args: { date: "2026-08-15", service_type: "emergency visit", duration_minutes: 30 } }]),
      toolCallResponse([
        {
          name: "create_appointment",
          args: {
            client_name: "Unknown",
            phone: CLIENT_PHONE,
            service_type: "emergency visit",
            datetime: "2026-08-15T15:00:00.000Z",
            duration_minutes: 30,
          },
        },
      ]),
      textResponse("Booked — you're in at the next available slot today."),
    );
    getAvailableSlots.mockResolvedValue([{ start: "2026-08-15T15:00:00.000Z", end: "2026-08-15T15:30:00.000Z", available: true }]);
    bookSlot.mockResolvedValue({ appointmentId: "appt_999", eventId: "evt_999", startTime: "2026-08-15T15:00:00.000Z" });

    const result = await processClientMessage(TENANT_ID, CLIENT_PHONE, "I need this fixed right now!!!");

    expect(result.toneAssessment.urgency).toBe(5);
    expect(result.actionsTaken).toEqual(["checked_available_slots", "created_appointment"]);
    expect(result.reply.length).toBeGreaterThan(0);

    // The second fetch call is the main (tool-enabled) round — assert the
    // urgency-driven guidance from promptBuilder actually made it into the
    // system prompt Groq received, not just that the mocked tools fired.
    const mainCallBody = capturedRequestBodies[1];
    const messages = mainCallBody?.["messages"] as { role: string; content: string }[] | undefined;
    const systemMessage = messages?.find((message) => message.role === "system");
    expect(systemMessage?.content).toContain("ultra-direct");
  });
});

// ---------------------------------------------------------------------------
// Scenario C — a non-clinic vertical (legal_services) gets its own prompt,
// not a clinic prompt with the labels swapped. Proves promptBuilder.ts's
// dynamic generation end to end: the right vertical rules, working hours,
// tone of voice, and FAQs all actually reach Groq, and the clinic-specific
// language genuinely never does for a tenant that isn't a clinic.
// ---------------------------------------------------------------------------

describe("Scenario C: a legal_services tenant gets a legal-specific prompt, not clinic language", () => {
  const legalTenant: Tenant = {
    ...fixtureTenant,
    id: "44444444-4444-4444-4444-444444444444",
    name: "Ionescu & Partners",
    businessType: "legal_services",
    toneOfVoice: "formal",
  };

  it("builds a prompt with legal rules, working hours, formal tone, and FAQs — and no clinic language", async () => {
    getTenantById.mockResolvedValueOnce(legalTenant);
    listFaqs.mockResolvedValueOnce([
      { id: "faq-1", tenantId: legalTenant.id, question: "Do you offer free consultations?", answer: "No, consultations are 250 RON.", displayOrder: 0, isActive: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    fetchQueue.push(
      toneResponse({ urgency: 1, formality: 4, sentiment: "neutral", toneNote: "Professional inquiry." }),
      textResponse("Bună ziua! Cu ce vă pot ajuta?"),
    );

    const result = await processClientMessage(legalTenant.id, CLIENT_PHONE, "Aș dori o consultație.");

    expect(result.reply.length).toBeGreaterThan(0);

    const mainCallBody = capturedRequestBodies[1];
    const messages = mainCallBody?.["messages"] as { role: string; content: string }[] | undefined;
    const systemMessage = messages?.find((message) => message.role === "system")?.content ?? "";

    // The right vertical's rules made it in...
    expect(systemMessage).toContain("professional services / legal practice");
    expect(systemMessage).toContain("never give legal advice");
    // ...the tenant's tone-of-voice choice made it in...
    expect(systemMessage).toContain("formal brand voice");
    // ...real working hours (not a canned/generic string) made it in...
    expect(systemMessage).toContain("Business hours");
    expect(systemMessage).toContain("09:00–17:00");
    // ...the FAQ made it in...
    expect(systemMessage).toContain("Do you offer free consultations?");
    // ...and no clinic-specific language leaked in for a tenant that isn't one.
    expect(systemMessage).not.toContain("medical clinic");
    expect(systemMessage).not.toContain("Never diagnose");
  });
});
