/**
 * Domain types shared across the backend and the frontend: tenants,
 * appointments, calendar slots, client profiles, and the Groq
 * function-calling contracts used by the adaptive agent. This module has no
 * runtime dependencies, so it's safe to import from either Node code or
 * React components.
 */

export type BusinessType = "restaurant" | "clinic" | "callcenter" | "auto_shop" | "salon" | "legal_services" | "general_services";

/** Fixed tenant-level brand-voice persona — distinct from ClientProfile.formalityScore (per-client, learned) and ToneAssessment (per-message, live-read). See promptBuilder.ts's describeToneOfVoice. */
export type ToneOfVoice = "formal" | "friendly";

/** Starter (self-serve, hard-capped defaults) vs VIP (manually onboarded, custom integrations unlocked) — see 022_onboarding_plans_and_leads.sql and src/api/routes/superAdmin.ts. */
export type TenantPlan = "starter" | "vip";

/** deepgram_only (fast/cheap) vs whisper_hybrid (Deepgram for real-time turn-detection + Whisper for the actual transcription — higher accuracy, one extra network round-trip per turn). See src/telephony/voiceStreamServer.ts. */
export type SttStrategy = "deepgram_only" | "whisper_hybrid";

export type AppointmentStatus = "confirmed" | "cancelled" | "rescheduled";

/** Which surface actually created the appointment — what makes the "AI agent efficiency" analytics metric a real measurement. */
export type BookingChannel = "ai_chat" | "ai_voice" | "staff_manual";

export type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export interface WeekdayHours {
  /** 24-hour local time, "HH:MM". */
  start: string;
  end: string;
}

/** Per-weekday open hours; `null` for a weekday means the tenant is closed that day. */
export type WorkingHours = Record<Weekday, WeekdayHours | null>;

export interface Tenant {
  id: string;
  ownerUserId: string;
  name: string;
  businessType: BusinessType;
  googleCalendarId: string;
  timezone: string;
  workingHours: WorkingHours;
  createdAt: string;
  /** Per-tenant ElevenLabs voice — null falls back to the ELEVENLABS_VOICE_ID env var default (see elevenLabsTts.ts). */
  elevenlabsVoiceId: string | null;
  /** Additional instructions appended to (not replacing) buildSystemPrompt's standard rules — see promptBuilder.ts for why this is additive, not a full override despite the column's name. */
  systemPromptOverride: string | null;
  /** Custom voice-call opening line; supports a literal "{company_name}" placeholder. Null falls back to the business-type-templated default (getVoiceGreeting). */
  greetingMessage: string | null;
  /** Deactivated tenants are rejected at public-facing entry points (widget chat, inbound Twilio routing) — see widgetChat.ts/webhooks.ts. */
  isActive: boolean;
  /** Human-facing contact number (016_tenant_business_info.sql) — distinct from the AI's inbound routing number (see the dedicated Twilio-only accessors in db/supabase.ts). */
  publicPhoneNumber: string | null;
  address: string | null;
  /** Fixed brand-voice persona injected into every system prompt (019_tenant_tone_and_faqs.sql). */
  toneOfVoice: ToneOfVoice;
  /** Starter or VIP tier — gates systemPromptOverride/voice selection/multi-calendar (see tenantSettings.ts's PATCH handler). */
  plan: TenantPlan;
  /** Tenant-specific override of promptBuilder.ts's static per-business-type required-booking-fields list — null means "use the static table". Set by the auto-configurator (src/agent/autoConfigurator.ts) or left null for a manually-onboarded tenant. */
  requiredBookingFields: string[] | null;
  /** Free (not plan-gated) opt-in to the Whisper hybrid STT pipeline — a latency/cost vs accuracy tradeoff the tenant chooses, not one Starter/VIP status should decide for them. */
  sttStrategy: SttStrategy;
}

/** A "Request VIP Integration" lead (022_onboarding_plans_and_leads.sql) — manually worked by a human, not a self-serve upgrade. */
export interface VipLead {
  id: string;
  tenantId: string;
  requestedIntegrations: string[];
  message: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  status: "new" | "contacted" | "won" | "lost";
  createdAt: string;
}

/** A caller question neither the tenant's own FAQs nor the niche fallback knowledge base covered (023_voice_improvements.sql) — a real recurring one is exactly what should become a real FAQ. See promptBuilder.ts's KNOWLEDGE_GAP_MARKER. */
export interface KnowledgeGap {
  id: string;
  tenantId: string;
  businessType: BusinessType;
  question: string;
  channel: BookingChannel;
  createdAt: string;
}

/** Per-turn latency breakdown for one voice-call utterance (023_voice_improvements.sql) — the "why is this call slow" visibility the pipeline never had. */
export interface VoiceCallMetric {
  id: string;
  tenantId: string;
  streamSid: string;
  sttStrategy: SttStrategy;
  whisperUsed: boolean;
  whisperLatencyMs: number | null;
  llmLatencyMs: number | null;
  ttsFirstByteLatencyMs: number | null;
  totalTurnLatencyMs: number | null;
  elevenlabsFallbackUsed: boolean;
  createdAt: string;
}

/** A persisted TTS/STT/LLM/Twilio failure (023_voice_improvements.sql) — previously only ever visible in a live server console. */
export interface ServiceFailure {
  id: string;
  tenantId: string | null;
  service: "elevenlabs" | "whisper" | "deepgram" | "groq" | "twilio";
  errorMessage: string;
  createdAt: string;
}

/** One billable-ish usage event (023_voice_improvements.sql) — Groq tokens, ElevenLabs characters, Whisper audio seconds, Twilio messages — so a tenant's real usage/cost is visible instead of invisible until a provider bill arrives. */
export interface UsageEvent {
  id: string;
  tenantId: string;
  service: "groq_llm" | "groq_whisper" | "elevenlabs_tts" | "twilio_sms" | "twilio_voice";
  quantity: number;
  unit: string;
  createdAt: string;
}

export interface Appointment {
  id: string;
  tenantId: string;
  clientId: string | null;
  googleEventId: string | null;
  serviceType: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  bookingChannel: BookingChannel;
  reminder24hSent: boolean;
  reminder2hSent: boolean;
  feedbackRequested: boolean;
  createdAt: string;
}

export interface Slot {
  start: string;
  end: string;
  available: boolean;
}

/** A 1 (very casual / very low) to 5 (highly formal / highly urgent) scale. */
export type FiveScale = 1 | 2 | 3 | 4 | 5;

export interface ClientProfile {
  id: string;
  tenantId: string;
  phoneNumber: string;
  fullName: string | null;
  formalityScore: FiveScale;
  communicationStyle: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type Sentiment = "positive" | "neutral" | "negative" | "frustrated";

/** Result of the lightweight single-pass tone/mood read on every inbound message. */
export interface ToneAssessment {
  urgency: FiveScale;
  formality: FiveScale;
  sentiment: Sentiment;
  toneNote: string;
}

export type ResponseStyle = "terse" | "empathetic" | "formal" | "friendly";

/** One logged interaction's tone read — the time series toneRefiner aggregates over. */
export interface ConversationLogEntry {
  id: string;
  tenantId: string;
  clientId: string;
  message: string;
  formalityScore: FiveScale;
  urgency: FiveScale;
  sentiment: Sentiment;
  toneNote: string;
  createdAt: string;
}

/** Per-tenant membership role. `super_admin` is platform-wide and isn't a tenant_members row — see 003_security_rls.sql. */
export type TenantRole = "tenant_admin" | "staff";

// ---------------------------------------------------------------------------
// Groq function-calling contracts
// ---------------------------------------------------------------------------

export interface GroqJsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean";
  description: string;
  enum?: readonly string[];
}

export interface GroqToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, GroqJsonSchemaProperty>;
      required: readonly string[];
    };
  };
}

export interface CheckAvailableSlotsArgs {
  date: string;
  service_type: string;
  duration_minutes: number;
}

export interface CreateAppointmentArgs {
  client_name: string;
  phone: string;
  service_type: string;
  datetime: string;
  duration_minutes: number;
}

export interface CancelAppointmentArgs {
  appointment_id: string;
  reason?: string;
}

/**
 * One earlier turn of the same conversation, fed back into
 * processClientMessage (src/agent/groqAgent.ts) so multi-turn exchanges
 * within a single call/session — e.g. the agent asking "Is that correct?"
 * and the caller replying "yes" — actually have something to refer to.
 * Without this, every turn is processed in isolation (see
 * groqAgent.ts's own comment on why that was the default, and
 * voiceStreamServer.ts for where call history is sourced from).
 */
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ProcessMessageResult {
  reply: string;
  toneAssessment: ToneAssessment;
  actionsTaken: string[];
  /** Set when this turn's tool calls actually created/cancelled an appointment — lets callers (e.g. callSession.ts) link a transcript to the booking without guessing. */
  createdAppointmentId?: string;
  cancelledAppointmentId?: string;
}

// ---------------------------------------------------------------------------
// Calendar engine contracts
// ---------------------------------------------------------------------------

export interface AppointmentRequest {
  phoneNumber: string;
  fullName: string;
  serviceType: string;
  /** ISO 8601 start time. */
  startTime: string;
  durationMinutes: number;
  bookingChannel: BookingChannel;
}

export interface BookingConfirmation {
  appointmentId: string;
  eventId: string;
  startTime: string;
}

// ---------------------------------------------------------------------------
// Messaging channel contracts
// ---------------------------------------------------------------------------

export type MessageChannel = "sms" | "whatsapp";

// ---------------------------------------------------------------------------
// Voice call contracts
// ---------------------------------------------------------------------------

export interface CallTranscriptRecord {
  id: string;
  tenantId: string;
  clientId: string | null;
  appointmentId: string | null;
  callSid: string;
  transcript: string;
  durationSeconds: number;
  /** Set when the caller showed sustained frustration during the call (callSession.ts) — a human should follow up. */
  needsFollowUp: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Offline sync contracts (PWA)
// ---------------------------------------------------------------------------

/** A staff-created appointment queued in IndexedDB while offline, awaiting sync. */
export interface PendingAppointment {
  localId: string;
  tenantId: string;
  phoneNumber: string;
  fullName: string;
  serviceType: string;
  /** ISO 8601 start time. */
  startTime: string;
  durationMinutes: number;
  queuedAt: string;
}

export interface SyncResult {
  synced: number;
  failed: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Analytics contracts
// ---------------------------------------------------------------------------

export type AnalyticsTimeframe = "7d" | "30d" | "all";

export interface TenantDailyStat {
  day: string;
  totalAppointments: number;
  cancelledAppointments: number;
  cancellationRatePct: number;
  peakBookingHour: number | null;
  avgFormalityScore: number | null;
}

export interface ToneDistribution {
  /** Keyed by formality score "1".."5". */
  formality: Record<string, number>;
  sentiment: Partial<Record<Sentiment, number>>;
}

export interface TenantDashboardMetrics {
  timeframe: AnalyticsTimeframe;
  dailyStats: TenantDailyStat[];
  toneDistribution: ToneDistribution;
  totalAppointments: number;
  cancellationRatePct: number;
  slotUtilizationRatePct: number;
  clientRetentionRatePct: number;
  /** % of confirmed bookings made via ai_chat or ai_voice, vs staff_manual. */
  aiAgentEfficiencyPct: number;
  bookingsByChannel: Partial<Record<BookingChannel, number>>;
  /** Booking counts by [weekday 0=Sun..6=Sat][hour 0-23], in the tenant's own timezone. */
  bookingHeatmap: number[][];
}

// ---------------------------------------------------------------------------
// Threat Sentinel (src/security/) — see supabase/migrations/011_security_logs.sql
// ---------------------------------------------------------------------------

export type ThreatCategory = "none" | "prompt_injection" | "role_hijack" | "system_leak" | "template_injection" | "sql_injection_probe" | "other";

export type SecurityLogStatus = "allowed" | "blocked";

/** The channel a threat-evaluated message arrived on — distinct from BookingChannel, which only covers what an appointment was *booked* through. */
export type SecurityChannel = "ai_chat" | "ai_voice" | "widget" | "sms_whatsapp" | "generic_webhook";

export interface BlacklistedPattern {
  id: string;
  /** JS RegExp source, no delimiters/flags — always compiled with 'gi'. */
  pattern: string;
  category: Exclude<ThreatCategory, "none">;
  /** Contribution to threat_score (0-100 scale) when this pattern matches. */
  severity: number;
  description: string | null;
  isActive: boolean;
  source: "seed" | "manual" | "learned";
  createdAt: string;
  updatedAt: string;
}

export interface ThreatEvaluation {
  score: number;
  category: ThreatCategory;
  matchedPattern: string | null;
  blocked: boolean;
}

export interface SecurityLogEntry {
  id: string;
  createdAt: string;
  ipAddress: string;
  tenantId: string | null;
  channel: SecurityChannel;
  rawPrompt: string;
  threatScore: number;
  threatCategory: ThreatCategory;
  matchedPattern: string | null;
  status: SecurityLogStatus;
}

// ---------------------------------------------------------------------------
// Services catalog — see supabase/migrations/015_services_catalog.sql
// ---------------------------------------------------------------------------

export type Currency = "RON" | "EUR";

export interface Service {
  id: string;
  tenantId: string;
  name: string;
  durationMinutes: number;
  /** Minor units (cents/bani) — see the migration's own comment for why, same reasoning as every other system that avoids floating-point money. */
  priceMinorUnits: number;
  currency: Currency;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Tenant FAQs — see supabase/migrations/019_tenant_tone_and_faqs.sql
// ---------------------------------------------------------------------------

export interface Faq {
  id: string;
  tenantId: string;
  question: string;
  answer: string;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
