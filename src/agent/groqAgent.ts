/**
 * Adaptive conversation engine: a client message goes through a fast,
 * single-pass tone/mood read (persisted to their profile), then a Groq
 * function-calling loop that can check availability, book, or cancel
 * appointments before producing a final tone-matched reply.
 *
 * Uses raw `fetch` against Groq's OpenAI-compatible endpoint — no SDK,
 * no extra dependencies — and targets low latency by keeping the tone pass
 * to a single small completion and only looping further when the model
 * actually requests a tool call.
 */
import { bookSlot, deleteCalendarEvent, getAvailableSlots } from "../calendar/googleCalendarEngine.js";
import { GoogleServiceAccountNotConfiguredError } from "../auth/googleServiceAccount.js";
import {
  getAppointmentById,
  getOrCreateClientProfile,
  getTenantById,
  insertConversationLog,
  insertKnowledgeGap,
  insertUsageEvent,
  listFaqs,
  listServices,
  SlotNoLongerAvailableError,
  updateAppointmentStatus,
  updateClientToneProfile,
} from "../db/supabase.js";
import { sanitizeUserInput } from "./guardrails.js";
import { buildSystemPrompt, KNOWLEDGE_GAP_MARKER } from "./promptBuilder.js";
import type {
  BookingChannel,
  CancelAppointmentArgs,
  CheckAvailableSlotsArgs,
  ClientProfile,
  ConversationTurn,
  CreateAppointmentArgs,
  FiveScale,
  GroqToolDefinition,
  ProcessMessageResult,
  Sentiment,
  Tenant,
  ToneAssessment,
} from "../types/index.js";

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
// llama-3.3-70b-versatile (the original model here) returned a hard 404
// model_not_found against this account's live key — confirmed via direct
// curl to Groq during E2E testing, and GET /openai/v1/models shows this
// account's catalog has no llama-3.x models at all anymore. Swapped to
// openai/gpt-oss-20b (verified: supports tool_choice/tool_calls AND
// response_format:{type:"json_object"}, both of which this file depends
// on) purely to unblock testing — this is a real model/quality/cost
// decision, not a like-for-like fix, and is worth revisiting deliberately
// rather than treating this constant as settled.
const GROQ_MODEL = "openai/gpt-oss-20b";
const MAX_TOOL_ROUNDS = 4;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;
const MAX_SLOTS_RETURNED_TO_MODEL = 10;

export class GroqUnavailableError extends Error {}

// ---------------------------------------------------------------------------
// Groq wire types (OpenAI-compatible chat completions with function calling)
// ---------------------------------------------------------------------------

interface GroqToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface GroqMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: GroqToolCall[];
  tool_call_id?: string;
}

interface GroqChatCompletionResponse {
  choices: { message: GroqMessage; finish_reason: string }[];
  /** OpenAI-compatible token accounting Groq returns on every completion — the actual number this app's usage tracking (usage_events, 023_voice_improvements.sql) reports, not an estimate. */
  usage?: { total_tokens?: number };
}

function isGroqChatCompletionResponse(value: unknown): value is GroqChatCompletionResponse {
  return typeof value === "object" && value !== null && Array.isArray((value as { choices?: unknown }).choices);
}

type GroqToolChoice = "auto" | "none";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface CallGroqOptions {
  tools?: GroqToolDefinition[];
  toolChoice?: GroqToolChoice;
  jsonMode?: boolean;
  /** When given, this call's real token usage (Groq's own count, not an estimate) is logged to usage_events — see the cost-visibility work in 023_voice_improvements.sql. Omitted for calls with no tenant context yet (there isn't one to attribute cost to). */
  tenantId?: string;
}

/**
 * Calls Groq with bounded retries on rate limiting / transient server
 * errors. Exported (beyond this file's own tone-assessment/tool-calling
 * loop) so other Groq-backed features — currently just
 * src/agent/autoConfigurator.ts's JSON-mode business-description parser —
 * reuse the exact same retry/timeout/error-handling behavior instead of
 * re-implementing a second, subtly different Groq client.
 */
export async function callGroq(messages: GroqMessage[], options: CallGroqOptions = {}): Promise<GroqMessage> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) {
    throw new GroqUnavailableError("Missing GROQ_API_KEY environment variable.");
  }

  const body: Record<string, unknown> = {
    model: GROQ_MODEL,
    messages,
    temperature: 0.3,
  };
  if (options.tools && options.tools.length > 0) {
    body["tools"] = options.tools;
    body["tool_choice"] = options.toolChoice ?? "auto";
  }
  if (options.jsonMode) {
    body["response_format"] = { type: "json_object" };
  }

  let lastError: Error = new GroqUnavailableError("Groq request failed for an unknown reason.");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = new GroqUnavailableError(
        `Groq request failed: ${error instanceof Error ? error.message : "network error"}`,
      );
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }

    if (response.ok) {
      const payload: unknown = await response.json();
      if (!isGroqChatCompletionResponse(payload) || payload.choices.length === 0) {
        throw new GroqUnavailableError("Groq chat completion response had an unexpected shape.");
      }
      const firstChoice = payload.choices[0];
      if (!firstChoice) {
        throw new GroqUnavailableError("Groq chat completion response contained no choices.");
      }
      if (options.tenantId && payload.usage?.total_tokens) {
        void insertUsageEvent({ tenantId: options.tenantId, service: "groq_llm", quantity: payload.usage.total_tokens, unit: "tokens" });
      }
      return firstChoice.message;
    }

    // Rate limited or transient server error: back off and retry.
    if (response.status === 429 || response.status >= 500) {
      lastError = new GroqUnavailableError(`Groq returned ${response.status}; will retry if attempts remain.`);
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }

    // Non-retryable client error (bad request, auth failure, etc.).
    const errorBody = await response.text();
    throw new GroqUnavailableError(`Groq chat completion request failed (${response.status}): ${errorBody}`);
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Tone & sentiment pass
// ---------------------------------------------------------------------------

const SENTIMENTS: readonly Sentiment[] = ["positive", "neutral", "negative", "frustrated"];

function isToneAssessment(value: unknown): value is ToneAssessment {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["urgency"] === "number" &&
    typeof candidate["formality"] === "number" &&
    typeof candidate["toneNote"] === "string" &&
    SENTIMENTS.includes(candidate["sentiment"] as Sentiment)
  );
}

function clampFiveScale(value: number): FiveScale {
  return Math.min(5, Math.max(1, Math.round(value))) as FiveScale;
}

const NEUTRAL_TONE_ASSESSMENT: ToneAssessment = {
  urgency: 3,
  formality: 3,
  sentiment: "neutral",
  toneNote: "Tone could not be assessed for this message.",
};

/** Single-pass mood read: one small, fast Groq call producing strict JSON. */
async function assessTone(message: string, tenantId: string): Promise<ToneAssessment> {
  const response = await callGroq(
    [
      {
        role: "system",
        content:
          "Read the tone of the following client message and respond with ONLY a JSON object of the exact " +
          'shape {"urgency": <1-5>, "formality": <1-5>, "sentiment": "positive"|"neutral"|"negative"|"frustrated", ' +
          '"toneNote": "<one short sentence>"}. ' +
          "urgency: 1 = no time pressure, 5 = emergency/immediate. formality: 1 = very casual, 5 = highly formal.",
      },
      { role: "user", content: message },
    ],
    { jsonMode: true, tenantId },
  );

  if (!response.content) {
    throw new GroqUnavailableError("Groq tone-assessment response had no content.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    throw new GroqUnavailableError("Groq tone-assessment response was not valid JSON.");
  }
  if (!isToneAssessment(parsed)) {
    throw new GroqUnavailableError("Groq tone-assessment response failed shape validation.");
  }

  return {
    urgency: clampFiveScale(parsed.urgency),
    formality: clampFiveScale(parsed.formality),
    sentiment: parsed.sentiment,
    toneNote: parsed.toneNote,
  };
}

function deriveCommunicationStyle(tone: ToneAssessment): string {
  if (tone.formality >= 4 && tone.urgency >= 4) return "formal and urgent";
  if (tone.formality >= 4) return "formal and measured";
  if (tone.urgency >= 4) return "casual but urgent";
  if (tone.formality <= 2 && tone.urgency <= 2) return "relaxed and casual";
  return "friendly and neutral";
}

async function assessAndPersistTone(tenantId: string, clientProfile: ClientProfile, message: string): Promise<{
  tone: ToneAssessment;
  updatedProfile: ClientProfile;
}> {
  let tone: ToneAssessment;
  try {
    tone = await assessTone(message, tenantId);
  } catch {
    // Best-effort degradation: keep the conversation going with a neutral
    // read rather than failing the whole turn over the tone pass alone.
    tone = NEUTRAL_TONE_ASSESSMENT;
  }

  // Log every assessed interaction — even a repeat/unchanged one — so
  // src/agent/toneRefiner.ts has a real time series to aggregate over.
  // Best-effort: a logging failure shouldn't break the conversation.
  try {
    await insertConversationLog({
      tenantId,
      clientId: clientProfile.id,
      message,
      formalityScore: tone.formality,
      urgency: tone.urgency,
      sentiment: tone.sentiment,
      toneNote: tone.toneNote,
    });
  } catch (error) {
    console.error("Failed to insert conversation log:", error);
  }

  const communicationStyle = deriveCommunicationStyle(tone);
  const changed =
    clientProfile.formalityScore !== tone.formality ||
    clientProfile.communicationStyle !== communicationStyle ||
    clientProfile.notes !== tone.toneNote;

  if (!changed) {
    return { tone, updatedProfile: clientProfile };
  }

  const updatedProfile = await updateClientToneProfile(tenantId, clientProfile.id, {
    formalityScore: tone.formality,
    communicationStyle,
    notes: tone.toneNote,
  });
  return { tone, updatedProfile };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const CHECK_AVAILABLE_SLOTS_TOOL: GroqToolDefinition = {
  type: "function",
  function: {
    name: "check_available_slots",
    description: "Look up open appointment slots on a given calendar day for a service type.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date to check, formatted YYYY-MM-DD." },
        service_type: { type: "string", description: "The service the client wants to book." },
        duration_minutes: {
          type: "integer",
          description: "Expected appointment length in minutes. Default to 30 if the client hasn't specified.",
        },
      },
      required: ["date", "service_type", "duration_minutes"],
    },
  },
};

const CREATE_APPOINTMENT_TOOL: GroqToolDefinition = {
  type: "function",
  function: {
    name: "create_appointment",
    description: "Book a confirmed appointment for the client on the tenant's calendar.",
    parameters: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Full name of the client." },
        phone: { type: "string", description: "Client's phone number." },
        service_type: { type: "string", description: "The service being booked." },
        datetime: { type: "string", description: "Appointment start time, ISO 8601." },
        duration_minutes: { type: "integer", description: "Appointment length in minutes." },
      },
      required: ["client_name", "phone", "service_type", "datetime", "duration_minutes"],
    },
  },
};

const CANCEL_APPOINTMENT_TOOL: GroqToolDefinition = {
  type: "function",
  function: {
    name: "cancel_appointment",
    description: "Cancel an existing confirmed appointment, in both the database and the calendar.",
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "The id of the appointment to cancel." },
        reason: { type: "string", description: "Optional reason the client gave for cancelling." },
      },
      required: ["appointment_id"],
    },
  },
};

const TOOLS = [CHECK_AVAILABLE_SLOTS_TOOL, CREATE_APPOINTMENT_TOOL, CANCEL_APPOINTMENT_TOOL];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function isCheckAvailableSlotsArgs(value: unknown): value is CheckAvailableSlotsArgs {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c["date"] === "string" && typeof c["service_type"] === "string" && typeof c["duration_minutes"] === "number";
}

function isCreateAppointmentArgs(value: unknown): value is CreateAppointmentArgs {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c["client_name"] === "string" &&
    typeof c["phone"] === "string" &&
    typeof c["service_type"] === "string" &&
    typeof c["datetime"] === "string" &&
    typeof c["duration_minutes"] === "number"
  );
}

function isCancelAppointmentArgs(value: unknown): value is CancelAppointmentArgs {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c["appointment_id"] === "string";
}

/**
 * Builds the JSON handed back to the model when a calendar tool call
 * fails. Previously this was just `{ error: error.message }` — a raw,
 * developer-facing string (e.g. "Missing GOOGLE_SERVICE_ACCOUNT_EMAIL...")
 * with no guidance on what to actually tell the client, which is why live
 * testing showed inconsistent recovery replies: sometimes vague ("let me
 * check, hang tight" with no follow-through), sometimes in English mid-
 * Romanian-conversation, never a clear, calm, same-language apology.
 *
 * GoogleServiceAccountNotConfiguredError specifically means "the calendar
 * backend itself isn't set up" — not a bad request, not "no slots today"
 * — so it gets its own branch with explicit instructions rather than
 * leaving the model to guess from a technical string. Any other error
 * (network blip, a transient Google 5xx, ...) gets the same treatment
 * generically, since the model shouldn't be reciting infrastructure
 * details to a client either way.
 */
function calendarToolErrorPayload(error: unknown): string {
  if (error instanceof SlotNoLongerAvailableError) {
    return JSON.stringify({
      error: "slot_taken",
      guidance:
        "That exact slot was just booked by someone else and is no longer available. Tell the client this " +
        "plainly, in the same language they've been using, and offer to check other times for the same day — " +
        "call check_available_slots again rather than guessing at another time.",
    });
  }
  if (error instanceof GoogleServiceAccountNotConfiguredError) {
    return JSON.stringify({
      error: "calendar_unavailable",
      guidance:
        "The calendar system is temporarily unavailable — this is not the client's fault and not something " +
        "a retry on your end will fix. Apologize briefly, in the same language the client has been using, and " +
        "let them know a staff member will follow up shortly to confirm the date/time, or that they're welcome " +
        "to call directly. Do not mention technical details, error messages, or environment variables.",
    });
  }
  return JSON.stringify({
    error: "tool_execution_failed",
    guidance:
      "Something went wrong checking the calendar. Apologize briefly, in the same language the client has " +
      "been using, and ask them to try again in a moment. Do not mention technical details.",
    detail: error instanceof Error ? error.message : "Unknown error.",
  });
}

async function executeCheckAvailableSlots(tenantId: string, rawArgs: unknown): Promise<string> {
  if (!isCheckAvailableSlotsArgs(rawArgs)) {
    return JSON.stringify({ error: "Invalid arguments for check_available_slots." });
  }
  try {
    const slots = await getAvailableSlots(tenantId, rawArgs.date, rawArgs.duration_minutes);
    const available = slots.filter((slot) => slot.available).slice(0, MAX_SLOTS_RETURNED_TO_MODEL);
    return JSON.stringify({ date: rawArgs.date, availableSlots: available });
  } catch (error) {
    return calendarToolErrorPayload(error);
  }
}

/** Mutated in place as tool calls succeed, so the caller can link a transcript/session to whatever booking actually happened this turn. */
interface TurnOutcome {
  createdAppointmentId?: string;
  cancelledAppointmentId?: string;
}

async function executeCreateAppointment(
  tenantId: string,
  rawArgs: unknown,
  bookingChannel: BookingChannel,
  outcome: TurnOutcome,
): Promise<string> {
  if (!isCreateAppointmentArgs(rawArgs)) {
    return JSON.stringify({ error: "Invalid arguments for create_appointment." });
  }
  try {
    const confirmation = await bookSlot(tenantId, {
      phoneNumber: rawArgs.phone,
      fullName: rawArgs.client_name,
      serviceType: rawArgs.service_type,
      startTime: rawArgs.datetime,
      durationMinutes: rawArgs.duration_minutes,
      bookingChannel,
    });
    outcome.createdAppointmentId = confirmation.appointmentId;
    return JSON.stringify({ confirmed: true, ...confirmation });
  } catch (error) {
    return calendarToolErrorPayload(error);
  }
}

async function executeCancelAppointment(tenant: Tenant, rawArgs: unknown, outcome: TurnOutcome): Promise<string> {
  if (!isCancelAppointmentArgs(rawArgs)) {
    return JSON.stringify({ error: "Invalid arguments for cancel_appointment." });
  }
  try {
    const appointment = await getAppointmentById(tenant.id, rawArgs.appointment_id);
    if (!appointment) {
      return JSON.stringify({ error: `No appointment found with id ${rawArgs.appointment_id}.` });
    }
    if (appointment.googleEventId) {
      await deleteCalendarEvent(tenant.id, tenant.googleCalendarId, appointment.googleEventId);
    }
    const updated = await updateAppointmentStatus(tenant.id, rawArgs.appointment_id, "cancelled");
    outcome.cancelledAppointmentId = updated.id;
    return JSON.stringify({ cancelled: true, appointmentId: updated.id, reason: rawArgs.reason ?? null });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : "Failed to cancel appointment." });
  }
}

async function executeToolCall(
  tenant: Tenant,
  toolCall: GroqToolCall,
  actionsTaken: string[],
  bookingChannel: BookingChannel,
  outcome: TurnOutcome,
): Promise<GroqMessage> {
  let rawArgs: unknown;
  try {
    rawArgs = JSON.parse(toolCall.function.arguments);
  } catch {
    rawArgs = {};
  }

  let resultContent: string;
  switch (toolCall.function.name) {
    case "check_available_slots":
      resultContent = await executeCheckAvailableSlots(tenant.id, rawArgs);
      actionsTaken.push("checked_available_slots");
      break;
    case "create_appointment":
      resultContent = await executeCreateAppointment(tenant.id, rawArgs, bookingChannel, outcome);
      actionsTaken.push("created_appointment");
      break;
    case "cancel_appointment":
      resultContent = await executeCancelAppointment(tenant, rawArgs, outcome);
      actionsTaken.push("cancelled_appointment");
      break;
    default:
      resultContent = JSON.stringify({ error: `Unknown tool "${toolCall.function.name}".` });
  }

  return { role: "tool", tool_call_id: toolCall.id, content: resultContent };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function fallbackResult(toneAssessment: ToneAssessment): ProcessMessageResult {
  return {
    reply:
      "I'm having trouble reaching our scheduling assistant right now. Please try again in a moment, " +
      "or call us directly and we'll help you right away.",
    toneAssessment,
    actionsTaken: [],
  };
}

function withOutcome(base: Omit<ProcessMessageResult, "createdAppointmentId" | "cancelledAppointmentId">, outcome: TurnOutcome): ProcessMessageResult {
  return {
    ...base,
    ...(outcome.createdAppointmentId ? { createdAppointmentId: outcome.createdAppointmentId } : {}),
    ...(outcome.cancelledAppointmentId ? { cancelledAppointmentId: outcome.cancelledAppointmentId } : {}),
  };
}

/**
 * Applied to every raw reply before it's ever returned — see
 * promptBuilder.ts's KNOWLEDGE_GAP_MARKER for the full mechanism. Strips
 * the marker (a client must never see or hear it) and, only when it was
 * actually present, fires a best-effort, non-blocking knowledge_gaps
 * insert with the client's real question — a logging hiccup here must
 * never fail or delay the reply the client is waiting for, hence
 * fire-and-forget rather than awaited.
 */
function finalizeReply(rawReply: string, tenant: Tenant, channel: BookingChannel, question: string): string {
  if (!rawReply.includes(KNOWLEDGE_GAP_MARKER)) {
    return rawReply;
  }
  void insertKnowledgeGap({ tenantId: tenant.id, businessType: tenant.businessType, question, channel }).catch((error: unknown) => {
    console.error(`Failed to log knowledge gap for tenant ${tenant.id}:`, error);
  });
  return rawReply.replaceAll(KNOWLEDGE_GAP_MARKER, "").trim();
}

/**
 * Processes one inbound client message end to end: sanitizes the input,
 * reads tone, persists it, runs the Groq function-calling loop against the
 * tenant's live calendar and appointment data, and returns a tone-matched
 * reply. `channel` records which surface this turn came in on (chat,
 * voice, ...) on any appointment it books.
 *
 * `conversationHistory` is optional and empty by default — every existing
 * caller (dashboard chat, widget, SMS/WhatsApp, generic webhook) keeps
 * treating each message as an isolated turn exactly as before. Only
 * voiceStreamServer.ts currently passes real history (from
 * callSession.ts's per-call transcript), because a live phone call is
 * where a memoryless "Is that correct?" / "yes" exchange is most
 * obviously broken — the same gap exists on every other channel too, just
 * less acutely, and isn't addressed here.
 */
export async function processClientMessage(
  tenantId: string,
  clientPhone: string,
  userMessage: string,
  channel: BookingChannel = "ai_chat",
  conversationHistory: ConversationTurn[] = [],
): Promise<ProcessMessageResult> {
  const sanitizedMessage = sanitizeUserInput(userMessage);

  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    throw new Error(`Unknown tenant: ${tenantId}`);
  }

  const clientProfile = await getOrCreateClientProfile(tenantId, clientPhone);
  const { tone, updatedProfile } = await assessAndPersistTone(tenantId, clientProfile, sanitizedMessage);
  // Queried fresh every turn, not cached — an edit made in the dashboard's
  // Services tab a moment ago is already what the *next* message sees,
  // with nothing to invalidate. See services.ts's own header comment. Same
  // reasoning for FAQs (faqs.ts's own header comment).
  const [activeServices, activeFaqs] = await Promise.all([
    listServices(tenantId, { activeOnly: true }),
    listFaqs(tenantId, { activeOnly: true }),
  ]);

  const conversation: GroqMessage[] = [
    { role: "system", content: buildSystemPrompt(tenant, updatedProfile, tone, channel, activeServices, activeFaqs) },
    ...conversationHistory.map((turn): GroqMessage => ({ role: turn.role, content: turn.content })),
    { role: "user", content: sanitizedMessage },
  ];

  const actionsTaken: string[] = [];
  const outcome: TurnOutcome = {};

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const isLastRound = round === MAX_TOOL_ROUNDS - 1;
      const response = await callGroq(conversation, {
        tools: TOOLS,
        toolChoice: isLastRound ? "none" : "auto",
        tenantId,
      });

      if (!response.tool_calls || response.tool_calls.length === 0) {
        return withOutcome({ reply: finalizeReply(response.content ?? "", tenant, channel, sanitizedMessage), toneAssessment: tone, actionsTaken }, outcome);
      }

      conversation.push(response);
      for (const toolCall of response.tool_calls) {
        conversation.push(await executeToolCall(tenant, toolCall, actionsTaken, channel, outcome));
      }
    }

    // Exhausted tool rounds without a final answer; ask once more with tools disabled.
    const finalResponse = await callGroq(conversation, { toolChoice: "none", tenantId });
    return withOutcome({ reply: finalizeReply(finalResponse.content ?? "", tenant, channel, sanitizedMessage), toneAssessment: tone, actionsTaken }, outcome);
  } catch (error) {
    if (error instanceof GroqUnavailableError) {
      // Previously silent — the client only ever saw the generic
      // fallback reply below, with no trace of *why* server-side. Found
      // during E2E testing: a bad GROQ_MODEL produced this exact
      // symptom and took a direct curl to Groq's API to actually
      // diagnose, since nothing here said so.
      console.error(`[groqAgent] Falling back to generic reply for tenant ${tenantId}: ${error.message}`);
      return fallbackResult(tone);
    }
    throw error;
  }
}
