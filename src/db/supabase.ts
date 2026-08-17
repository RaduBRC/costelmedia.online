/**
 * Typed Supabase client + row-level data access helpers for the tables
 * defined in `supabase/migrations/`. The backend always talks to Supabase
 * with the service_role key, so RLS is bypassed here by design — tenant
 * isolation at this layer is enforced explicitly by always filtering/writing
 * with `tenant_id` (or, for push_subscriptions, a join through it).
 */
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Appointment,
  AppointmentStatus,
  BlacklistedPattern,
  BookingChannel,
  BusinessType,
  CallTranscriptRecord,
  ClientProfile,
  ConversationLogEntry,
  Currency,
  Faq,
  FiveScale,
  Sentiment,
  SecurityChannel,
  SecurityLogStatus,
  Service,
  Tenant,
  TenantDailyStat,
  TenantRole,
  ThreatCategory,
  ToneDistribution,
  ToneOfVoice,
  WorkingHours,
} from "../types/index.js";

// NOTE: these row shapes must be `type` aliases, not `interface`s — Supabase's
// GenericTable constraint checks `Row extends Record<string, unknown>`, and
// TypeScript only synthesizes the implicit index signature that check relies
// on for object-literal type aliases, not for named interfaces.
type TenantRow = {
  id: string;
  owner_user_id: string;
  name: string;
  business_type: BusinessType;
  google_calendar_id: string;
  timezone: string;
  working_hours: WorkingHours;
  created_at: string;
  // Sensitive — deliberately never mapped into the shared `Tenant` type
  // (see toTenant()). Only read through the dedicated accessors below,
  // which return narrow, purpose-built shapes instead of the full row.
  api_key_hash: string | null;
  api_key_created_at: string | null;
  twilio_phone_number: string | null;
  twilio_account_sid: string | null;
  twilio_auth_token: string | null;
  whatsapp_enabled: boolean;
  elevenlabs_voice_id: string | null;
  system_prompt_override: string | null;
  greeting_message: string | null;
  is_active: boolean;
  public_phone_number: string | null;
  address: string | null;
  // Sensitive (AES-256-GCM ciphertext, never plaintext) — same
  // never-mapped-into-Tenant rule as api_key_hash/twilio_auth_token above.
  // Only read through getGoogleOAuthTokenRow/getGoogleCalendarConnectionStatus.
  google_access_token: string | null;
  google_refresh_token: string | null;
  google_token_expiry: string | null;
  google_sync_enabled: boolean;
  tone_of_voice: ToneOfVoice;
};

type ClientProfileRow = {
  id: string;
  tenant_id: string;
  phone_number: string;
  full_name: string | null;
  formality_score: number;
  communication_style: string;
  notes: string;
  created_at: string;
  updated_at: string;
};

type AppointmentRow = {
  id: string;
  tenant_id: string;
  client_id: string | null;
  google_event_id: string | null;
  service_type: string;
  start_time: string;
  end_time: string;
  status: AppointmentStatus;
  booking_channel: BookingChannel;
  reminder_24h_sent: boolean;
  reminder_2h_sent: boolean;
  feedback_requested: boolean;
  created_at: string;
};

export type PushPlatform = "android" | "ios" | "web";

type PushSubscriptionRow = {
  id: string;
  user_id: string;
  platform: PushPlatform;
  target: Record<string, unknown>;
  created_at: string;
};

type TenantMemberRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  role: TenantRole;
  created_at: string;
};

type ConversationLogRow = {
  id: string;
  tenant_id: string;
  client_id: string;
  message: string;
  formality_score: number;
  urgency: number;
  sentiment: Sentiment;
  tone_note: string;
  created_at: string;
};

type CallTranscriptRow = {
  id: string;
  tenant_id: string;
  client_id: string | null;
  appointment_id: string | null;
  call_sid: string;
  transcript: string;
  duration_seconds: number;
  created_at: string;
};

type BlacklistedPatternRow = {
  id: string;
  pattern: string;
  category: Exclude<ThreatCategory, "none">;
  severity: number;
  description: string | null;
  is_active: boolean;
  source: "seed" | "manual" | "learned";
  created_at: string;
  updated_at: string;
};

type SecurityLogRow = {
  id: string;
  created_at: string;
  ip_address: string;
  tenant_id: string | null;
  channel: SecurityChannel;
  raw_prompt: string;
  threat_score: number;
  threat_category: ThreatCategory;
  matched_pattern: string | null;
  status: SecurityLogStatus;
};

type ServiceRow = {
  id: string;
  tenant_id: string;
  name: string;
  duration_minutes: number;
  price_minor_units: number;
  currency: Currency;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type FaqRow = {
  id: string;
  tenant_id: string;
  question: string;
  answer: string;
  display_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** Row shape of the `v_tenant_daily_stats` view (009_analytics_views.sql). */
type TenantDailyStatRow = {
  tenant_id: string;
  day: string;
  total_appointments: number;
  cancelled_appointments: number;
  cancellation_rate_pct: number;
  peak_booking_hour: number | null;
  avg_formality_score: number | null;
};

export interface Database {
  public: {
    Tables: {
      tenants: {
        Row: TenantRow;
        // Only truly-required-at-creation columns are non-optional here —
        // the rest have DB defaults or are legitimately nullable, and
        // forcing every caller to spell them out (as the old, stricter
        // type did) made a plain "create a tenant" insert unnecessarily
        // verbose everywhere from this file's own insertTenant() outward.
        Insert: Omit<
          TenantRow,
          | "id"
          | "created_at"
          | "working_hours"
          | "api_key_hash"
          | "api_key_created_at"
          | "twilio_phone_number"
          | "twilio_account_sid"
          | "twilio_auth_token"
          | "whatsapp_enabled"
          | "elevenlabs_voice_id"
          | "system_prompt_override"
          | "greeting_message"
          | "is_active"
          | "public_phone_number"
          | "address"
          | "google_access_token"
          | "google_refresh_token"
          | "google_token_expiry"
          | "google_sync_enabled"
          | "tone_of_voice"
        > & {
          id?: string;
          created_at?: string;
          working_hours?: WorkingHours;
          api_key_hash?: string | null;
          api_key_created_at?: string | null;
          twilio_phone_number?: string | null;
          twilio_account_sid?: string | null;
          twilio_auth_token?: string | null;
          whatsapp_enabled?: boolean;
          elevenlabs_voice_id?: string | null;
          system_prompt_override?: string | null;
          greeting_message?: string | null;
          is_active?: boolean;
          public_phone_number?: string | null;
          address?: string | null;
          google_access_token?: string | null;
          google_refresh_token?: string | null;
          google_token_expiry?: string | null;
          google_sync_enabled?: boolean;
          tone_of_voice?: ToneOfVoice;
        };
        Update: Partial<Omit<TenantRow, "id">>;
        Relationships: [];
      };
      client_profiles: {
        Row: ClientProfileRow;
        Insert: Omit<ClientProfileRow, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<ClientProfileRow, "id" | "tenant_id">>;
        Relationships: [];
      };
      appointments: {
        Row: AppointmentRow;
        Insert: Omit<
          AppointmentRow,
          "id" | "created_at" | "booking_channel" | "reminder_24h_sent" | "reminder_2h_sent" | "feedback_requested"
        > & {
          id?: string;
          created_at?: string;
          booking_channel?: BookingChannel;
          reminder_24h_sent?: boolean;
          reminder_2h_sent?: boolean;
          feedback_requested?: boolean;
        };
        Update: Partial<Omit<AppointmentRow, "id" | "tenant_id">>;
        Relationships: [];
      };
      push_subscriptions: {
        Row: PushSubscriptionRow;
        Insert: Omit<PushSubscriptionRow, "id" | "created_at"> & { id?: string; created_at?: string };
        Update: Partial<Omit<PushSubscriptionRow, "id" | "user_id">>;
        Relationships: [];
      };
      tenant_members: {
        Row: TenantMemberRow;
        Insert: Omit<TenantMemberRow, "id" | "created_at"> & { id?: string; created_at?: string };
        Update: Partial<Omit<TenantMemberRow, "id">>;
        Relationships: [];
      };
      conversation_logs: {
        Row: ConversationLogRow;
        Insert: Omit<ConversationLogRow, "id" | "created_at"> & { id?: string; created_at?: string };
        Update: Partial<Omit<ConversationLogRow, "id">>;
        Relationships: [];
      };
      call_transcripts: {
        Row: CallTranscriptRow;
        Insert: Omit<CallTranscriptRow, "id" | "created_at"> & { id?: string; created_at?: string };
        Update: Partial<Omit<CallTranscriptRow, "id" | "tenant_id">>;
        Relationships: [];
      };
      blacklisted_patterns: {
        Row: BlacklistedPatternRow;
        Insert: Omit<BlacklistedPatternRow, "id" | "created_at" | "updated_at" | "is_active" | "source"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          is_active?: boolean;
          source?: "seed" | "manual" | "learned";
        };
        Update: Partial<Omit<BlacklistedPatternRow, "id">>;
        Relationships: [];
      };
      security_logs: {
        Row: SecurityLogRow;
        Insert: Omit<SecurityLogRow, "id" | "created_at" | "tenant_id" | "matched_pattern"> & {
          id?: string;
          created_at?: string;
          tenant_id?: string | null;
          matched_pattern?: string | null;
        };
        Update: Partial<Omit<SecurityLogRow, "id">>;
        Relationships: [];
      };
      services: {
        Row: ServiceRow;
        Insert: Omit<ServiceRow, "id" | "created_at" | "updated_at" | "currency" | "description" | "is_active"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          currency?: Currency;
          description?: string | null;
          is_active?: boolean;
        };
        Update: Partial<Omit<ServiceRow, "id" | "tenant_id">>;
        Relationships: [];
      };
      tenant_faqs: {
        Row: FaqRow;
        Insert: Omit<FaqRow, "id" | "created_at" | "updated_at" | "display_order" | "is_active"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          display_order?: number;
          is_active?: boolean;
        };
        Update: Partial<Omit<FaqRow, "id" | "tenant_id">>;
        Relationships: [];
      };
    };
    Views: {
      v_tenant_daily_stats: {
        Row: TenantDailyStatRow;
        Relationships: [];
      };
    };
    Functions: {
      get_tone_distribution: {
        Args: { p_tenant_id: string };
        Returns: unknown;
      };
      list_index_names: {
        Args: Record<string, never>;
        Returns: string[];
      };
    };
  };
}

let cachedClient: SupabaseClient<Database> | null = null;

/** Lazily instantiated, memoized service-role Supabase client. */
export function getSupabaseClient(): SupabaseClient<Database> {
  if (cachedClient) {
    return cachedClient;
  }

  const url = process.env["SUPABASE_URL"];
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];

  if (!url || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
  }

  cachedClient = createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Mapping helpers (snake_case rows <-> camelCase domain types)
// ---------------------------------------------------------------------------

// Deliberately narrow: only the columns safe to hand back to an API
// response go here. `api_key_hash`, `twilio_account_sid`, and
// `twilio_auth_token` are read via the dedicated accessors further down
// instead, so there's no path from `getTenantById` to a leaked secret.
function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    businessType: row.business_type,
    googleCalendarId: row.google_calendar_id,
    timezone: row.timezone,
    workingHours: row.working_hours,
    createdAt: row.created_at,
    elevenlabsVoiceId: row.elevenlabs_voice_id,
    systemPromptOverride: row.system_prompt_override,
    greetingMessage: row.greeting_message,
    isActive: row.is_active,
    publicPhoneNumber: row.public_phone_number,
    address: row.address,
    toneOfVoice: row.tone_of_voice,
  };
}

function clampFiveScale(value: number): FiveScale {
  return Math.min(5, Math.max(1, Math.round(value))) as FiveScale;
}

function toClientProfile(row: ClientProfileRow): ClientProfile {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    phoneNumber: row.phone_number,
    fullName: row.full_name,
    formalityScore: clampFiveScale(row.formality_score),
    communicationStyle: row.communication_style,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    googleEventId: row.google_event_id,
    serviceType: row.service_type,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    bookingChannel: row.booking_channel,
    reminder24hSent: row.reminder_24h_sent,
    reminder2hSent: row.reminder_2h_sent,
    feedbackRequested: row.feedback_requested,
    createdAt: row.created_at,
  };
}

function toCallTranscriptRecord(row: CallTranscriptRow): CallTranscriptRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    appointmentId: row.appointment_id,
    callSid: row.call_sid,
    transcript: row.transcript,
    durationSeconds: row.duration_seconds,
    createdAt: row.created_at,
  };
}

function toTenantDailyStat(row: TenantDailyStatRow): TenantDailyStat {
  return {
    day: row.day,
    totalAppointments: row.total_appointments,
    cancelledAppointments: row.cancelled_appointments,
    cancellationRatePct: row.cancellation_rate_pct,
    peakBookingHour: row.peak_booking_hour,
    avgFormalityScore: row.avg_formality_score,
  };
}

function toConversationLogEntry(row: ConversationLogRow): ConversationLogEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    message: row.message,
    formalityScore: clampFiveScale(row.formality_score),
    urgency: clampFiveScale(row.urgency),
    sentiment: row.sentiment,
    toneNote: row.tone_note,
    createdAt: row.created_at,
  };
}

function toBlacklistedPattern(row: BlacklistedPatternRow): BlacklistedPattern {
  return {
    id: row.id,
    pattern: row.pattern,
    category: row.category,
    severity: row.severity,
    description: row.description,
    isActive: row.is_active,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toService(row: ServiceRow): Service {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    priceMinorUnits: row.price_minor_units,
    currency: row.currency,
    description: row.description,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFaq(row: FaqRow): Faq {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    question: row.question,
    answer: row.answer,
    displayOrder: row.display_order,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// tenants
// ---------------------------------------------------------------------------

export async function getTenantById(tenantId: string): Promise<Tenant | null> {
  const { data, error } = await getSupabaseClient().from("tenants").select("*").eq("id", tenantId).maybeSingle();

  if (error) {
    throw new Error(`Failed to load tenant ${tenantId}: ${error.message}`);
  }
  return data ? toTenant(data) : null;
}

/** Standard weekday 9–5, closed weekends — used whenever a caller (seed script, tenant provisioning) doesn't specify working hours up front. */
export const DEFAULT_WORKING_HOURS: WorkingHours = {
  monday: { start: "09:00", end: "17:00" },
  tuesday: { start: "09:00", end: "17:00" },
  wednesday: { start: "09:00", end: "17:00" },
  thursday: { start: "09:00", end: "17:00" },
  friday: { start: "09:00", end: "17:00" },
  saturday: null,
  sunday: null,
};

export async function insertTenant(input: {
  ownerUserId: string;
  name: string;
  businessType: BusinessType;
  googleCalendarId: string;
  timezone?: string;
  workingHours?: WorkingHours;
  elevenlabsVoiceId?: string | null;
  systemPromptOverride?: string | null;
  greetingMessage?: string | null;
  isActive?: boolean;
}): Promise<Tenant> {
  const { data, error } = await getSupabaseClient()
    .from("tenants")
    .insert({
      owner_user_id: input.ownerUserId,
      name: input.name,
      business_type: input.businessType,
      google_calendar_id: input.googleCalendarId,
      timezone: input.timezone ?? "UTC",
      working_hours: input.workingHours ?? DEFAULT_WORKING_HOURS,
      elevenlabs_voice_id: input.elevenlabsVoiceId ?? null,
      system_prompt_override: input.systemPromptOverride ?? null,
      greeting_message: input.greetingMessage ?? null,
      is_active: input.isActive ?? true,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create tenant: ${error?.message ?? "unknown error"}`);
  }
  return toTenant(data);
}

/**
 * Backs PATCH /api/tenants/:tenantId (tenant_admin only — see
 * src/api/routes/tenantSettings.ts). Deliberately narrower than the full
 * Update type: only the fields /admin/settings actually edits are
 * reachable here, so this can't accidentally become a generic
 * "set any column" endpoint — infrastructure fields (googleCalendarId,
 * Twilio credentials, api key) stay untouchable from this path.
 */
export async function updateTenant(
  tenantId: string,
  patch: Partial<{
    name: string;
    businessType: BusinessType;
    workingHours: WorkingHours;
    elevenlabsVoiceId: string | null;
    systemPromptOverride: string | null;
    greetingMessage: string | null;
    publicPhoneNumber: string | null;
    address: string | null;
    toneOfVoice: ToneOfVoice;
  }>,
): Promise<Tenant> {
  const update: Database["public"]["Tables"]["tenants"]["Update"] = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.businessType !== undefined ? { business_type: patch.businessType } : {}),
    ...(patch.workingHours !== undefined ? { working_hours: patch.workingHours } : {}),
    ...(patch.elevenlabsVoiceId !== undefined ? { elevenlabs_voice_id: patch.elevenlabsVoiceId } : {}),
    ...(patch.systemPromptOverride !== undefined ? { system_prompt_override: patch.systemPromptOverride } : {}),
    ...(patch.greetingMessage !== undefined ? { greeting_message: patch.greetingMessage } : {}),
    ...(patch.publicPhoneNumber !== undefined ? { public_phone_number: patch.publicPhoneNumber } : {}),
    ...(patch.address !== undefined ? { address: patch.address } : {}),
    ...(patch.toneOfVoice !== undefined ? { tone_of_voice: patch.toneOfVoice } : {}),
  };

  const { data, error } = await getSupabaseClient().from("tenants").update(update).eq("id", tenantId).select("*").single();

  if (error || !data) {
    throw new Error(`Failed to update tenant ${tenantId}: ${error?.message ?? "unknown error"}`);
  }
  return toTenant(data);
}

/** For idempotent provisioning flows (the seed script, tenant registration) that need to check "does this owner already have a tenant?" before creating a duplicate. */
export async function getTenantByOwnerUserId(ownerUserId: string): Promise<Tenant | null> {
  const { data, error } = await getSupabaseClient().from("tenants").select("*").eq("owner_user_id", ownerUserId).maybeSingle();

  if (error) {
    throw new Error(`Failed to look up tenant for owner ${ownerUserId}: ${error.message}`);
  }
  return data ? toTenant(data) : null;
}

/** Cascades to client_profiles/appointments/conversation_logs/etc. via FK — only for dev/test tooling (the seed script's --reset), never a tenant-facing route. */
export async function deleteTenant(tenantId: string): Promise<void> {
  const { error } = await getSupabaseClient().from("tenants").delete().eq("id", tenantId);
  if (error) {
    throw new Error(`Failed to delete tenant ${tenantId}: ${error.message}`);
  }
}

/**
 * Per-tenant Twilio routing/credentials. Nullable `accountSid`/`authToken`
 * mean the tenant uses the platform's shared Twilio account (env vars) —
 * resolving that fallback is the channel layer's job (src/channels/twilioService.ts),
 * not this data-access layer's.
 */
export interface TenantTwilioRouting {
  tenantId: string;
  phoneNumber: string | null;
  accountSid: string | null;
  authToken: string | null;
  whatsappEnabled: boolean;
  /** Callers should reject routing to an inactive tenant rather than silently processing the call — see src/api/webhooks.ts. */
  isActive: boolean;
}

function toTenantTwilioRouting(row: TenantRow): TenantTwilioRouting {
  return {
    tenantId: row.id,
    phoneNumber: row.twilio_phone_number,
    accountSid: row.twilio_account_sid,
    authToken: row.twilio_auth_token,
    isActive: row.is_active,
    whatsappEnabled: row.whatsapp_enabled,
  };
}

/** Resolves a tenant from an inbound webhook's `To` number — the routing step before signature verification. */
export async function getTenantTwilioRoutingByPhoneNumber(phoneNumber: string): Promise<TenantTwilioRouting | null> {
  const { data, error } = await getSupabaseClient()
    .from("tenants")
    .select("*")
    .eq("twilio_phone_number", phoneNumber)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to resolve tenant for Twilio number ${phoneNumber}: ${error.message}`);
  }
  return data ? toTenantTwilioRouting(data) : null;
}

export async function getTenantTwilioRouting(tenantId: string): Promise<TenantTwilioRouting | null> {
  const { data, error } = await getSupabaseClient().from("tenants").select("*").eq("id", tenantId).maybeSingle();

  if (error) {
    throw new Error(`Failed to load Twilio routing for tenant ${tenantId}: ${error.message}`);
  }
  return data ? toTenantTwilioRouting(data) : null;
}

/** Resolves a tenant from a hashed `X-API-Key` header (see requireApiKey). */
export async function getTenantByApiKeyHash(apiKeyHash: string): Promise<Tenant | null> {
  const { data, error } = await getSupabaseClient().from("tenants").select("*").eq("api_key_hash", apiKeyHash).maybeSingle();

  if (error) {
    throw new Error(`Failed to resolve tenant by API key: ${error.message}`);
  }
  return data ? toTenant(data) : null;
}

// ---------------------------------------------------------------------------
// Google OAuth (per-tenant calendar connection — 017_google_oauth_calendar.sql)
//
// Ciphertext in, ciphertext out: this file never decrypts a token, and
// never returns one through `Tenant`/`toTenant()` — encryption/decryption
// and the "is it actually usable" expiry logic live in
// src/auth/googleOAuthTokens.ts, which is the only caller of the two raw
// accessors below. getGoogleCalendarConnectionStatus, by contrast, is safe
// to expose straight to the frontend (no token material at all) — it's
// what the Settings page's connection badge renders from.
// ---------------------------------------------------------------------------

export interface GoogleOAuthTokenRow {
  encryptedAccessToken: string | null;
  encryptedRefreshToken: string | null;
  tokenExpiry: string | null;
  syncEnabled: boolean;
  calendarId: string;
}

export async function getGoogleOAuthTokenRow(tenantId: string): Promise<GoogleOAuthTokenRow | null> {
  const { data, error } = await getSupabaseClient()
    .from("tenants")
    .select("google_access_token, google_refresh_token, google_token_expiry, google_sync_enabled, google_calendar_id")
    .eq("id", tenantId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read Google OAuth tokens for tenant ${tenantId}: ${error.message}`);
  }
  if (!data) {
    return null;
  }
  return {
    encryptedAccessToken: data.google_access_token,
    encryptedRefreshToken: data.google_refresh_token,
    tokenExpiry: data.google_token_expiry,
    syncEnabled: data.google_sync_enabled,
    calendarId: data.google_calendar_id,
  };
}

/** Full connect: stores a freshly-exchanged token pair and flips sync on. */
export async function setGoogleOAuthTokens(
  tenantId: string,
  input: { encryptedAccessToken: string; encryptedRefreshToken: string; tokenExpiry: string },
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("tenants")
    .update({
      google_access_token: input.encryptedAccessToken,
      google_refresh_token: input.encryptedRefreshToken,
      google_token_expiry: input.tokenExpiry,
      google_sync_enabled: true,
    })
    .eq("id", tenantId);

  if (error) {
    throw new Error(`Failed to store Google OAuth tokens for tenant ${tenantId}: ${error.message}`);
  }
}

/** Refresh-only: a new access token from the stored refresh token — the refresh token itself and sync_enabled are untouched. */
export async function updateGoogleOAuthAccessToken(
  tenantId: string,
  input: { encryptedAccessToken: string; tokenExpiry: string },
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("tenants")
    .update({ google_access_token: input.encryptedAccessToken, google_token_expiry: input.tokenExpiry })
    .eq("id", tenantId);

  if (error) {
    throw new Error(`Failed to update Google OAuth access token for tenant ${tenantId}: ${error.message}`);
  }
}

/** Disconnect: clears all stored token material and turns sync back off — googleCalendarEngine.ts falls back to the platform service account on the very next call. */
export async function clearGoogleOAuthTokens(tenantId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("tenants")
    .update({ google_access_token: null, google_refresh_token: null, google_token_expiry: null, google_sync_enabled: false })
    .eq("id", tenantId);

  if (error) {
    throw new Error(`Failed to clear Google OAuth tokens for tenant ${tenantId}: ${error.message}`);
  }
}

export interface GoogleCalendarConnectionStatus {
  connected: boolean;
  calendarId: string;
}

/** Token-free status for the frontend (Settings' Google Calendar card) — never touches google_access_token/refresh_token. */
export async function getGoogleCalendarConnectionStatus(tenantId: string): Promise<GoogleCalendarConnectionStatus | null> {
  const { data, error } = await getSupabaseClient()
    .from("tenants")
    .select("google_sync_enabled, google_calendar_id")
    .eq("id", tenantId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read Google Calendar connection status for tenant ${tenantId}: ${error.message}`);
  }
  return data ? { connected: data.google_sync_enabled, calendarId: data.google_calendar_id } : null;
}

// ---------------------------------------------------------------------------
// Supabase Auth admin (service-role only — creates/looks up/removes users;
// used by scripts/seedData.ts and src/api/tenantProvisioning.ts)
// ---------------------------------------------------------------------------

export interface AuthUserSummary {
  id: string;
  email: string;
}

export async function createAuthUser(email: string, password: string): Promise<AuthUserSummary> {
  const { data, error } = await getSupabaseClient().auth.admin.createUser({
    email,
    password,
    // Service-role-created account (seed data, or a newly-provisioned
    // tenant admin) — there's no inbox to click a confirmation link from.
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Failed to create auth user ${email}: ${error?.message ?? "unknown error"}`);
  }
  return { id: data.user.id, email: data.user.email ?? email };
}

const AUTH_USER_SEARCH_PAGE_SIZE = 200;
const AUTH_USER_SEARCH_MAX_PAGES = 10;

/**
 * The Admin API has no server-side "find by email" — only pagination — so
 * this walks pages looking for a match. Fine at this project's current
 * scale (dev/test tooling and tenant sign-up, not a high-volume user
 * directory); revisit if the user base ever grows past a few thousand.
 */
export async function getAuthUserByEmail(email: string): Promise<AuthUserSummary | null> {
  const normalizedEmail = email.trim().toLowerCase();

  for (let page = 1; page <= AUTH_USER_SEARCH_MAX_PAGES; page++) {
    const { data, error } = await getSupabaseClient().auth.admin.listUsers({ page, perPage: AUTH_USER_SEARCH_PAGE_SIZE });
    if (error) {
      throw new Error(`Failed to search auth users: ${error.message}`);
    }
    const match = data.users.find((user) => user.email?.toLowerCase() === normalizedEmail);
    if (match) {
      return { id: match.id, email: match.email ?? normalizedEmail };
    }
    if (data.users.length < AUTH_USER_SEARCH_PAGE_SIZE) {
      break; // Fewer than a full page came back — that was the last one.
    }
  }
  return null;
}

/** Dev/test tooling only (the seed script's --reset) — never expose deletion of an arbitrary auth user on a tenant-facing route. */
export async function deleteAuthUser(userId: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.admin.deleteUser(userId);
  if (error) {
    throw new Error(`Failed to delete auth user ${userId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// client_profiles
// ---------------------------------------------------------------------------

/** Fetches an existing client profile by phone number, or creates one. */
export async function getOrCreateClientProfile(tenantId: string, phoneNumber: string): Promise<ClientProfile> {
  const client = getSupabaseClient();

  const { data: existing, error: selectError } = await client
    .from("client_profiles")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("phone_number", phoneNumber)
    .maybeSingle();

  if (selectError) {
    throw new Error(`Failed to look up client profile: ${selectError.message}`);
  }
  if (existing) {
    return toClientProfile(existing);
  }

  const { data: created, error: insertError } = await client
    .from("client_profiles")
    .insert({
      tenant_id: tenantId,
      phone_number: phoneNumber,
      full_name: null,
      formality_score: 3,
      communication_style: "",
      notes: "",
    })
    .select("*")
    .single();

  if (insertError || !created) {
    throw new Error(`Failed to create client profile: ${insertError?.message ?? "unknown error"}`);
  }
  return toClientProfile(created);
}

export async function updateClientToneProfile(
  tenantId: string,
  clientId: string,
  update: { formalityScore: FiveScale; communicationStyle: string; notes: string },
): Promise<ClientProfile> {
  const { data, error } = await getSupabaseClient()
    .from("client_profiles")
    .update({
      formality_score: update.formalityScore,
      communication_style: update.communicationStyle,
      notes: update.notes,
    })
    .eq("tenant_id", tenantId)
    .eq("id", clientId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to update client tone profile: ${error?.message ?? "unknown error"}`);
  }
  return toClientProfile(data);
}

export async function updateClientName(tenantId: string, clientId: string, fullName: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("client_profiles")
    .update({ full_name: fullName })
    .eq("tenant_id", tenantId)
    .eq("id", clientId);

  if (error) {
    throw new Error(`Failed to update client name: ${error.message}`);
  }
}

export async function getClientProfileById(tenantId: string, clientId: string): Promise<ClientProfile | null> {
  const { data, error } = await getSupabaseClient()
    .from("client_profiles")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", clientId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load client profile ${clientId}: ${error.message}`);
  }
  return data ? toClientProfile(data) : null;
}

/** Same caveat as getAppointmentByIdUnscoped: internal system paths only (e.g. the reminder scheduler). */
export async function getClientProfileByIdUnscoped(clientId: string): Promise<ClientProfile | null> {
  const { data, error } = await getSupabaseClient().from("client_profiles").select("*").eq("id", clientId).maybeSingle();

  if (error) {
    throw new Error(`Failed to load client profile ${clientId}: ${error.message}`);
  }
  return data ? toClientProfile(data) : null;
}

/**
 * Partial update used by the tone refiner: recalculated formality +
 * communication-style summary only. Deliberately doesn't touch `notes`,
 * which holds the *latest* interaction's context, not an aggregate summary
 * — clobbering it here would erase information the live agent still needs.
 */
export async function refineClientProfile(
  tenantId: string,
  clientId: string,
  update: { formalityScore: FiveScale; communicationStyle: string },
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("client_profiles")
    .update({ formality_score: update.formalityScore, communication_style: update.communicationStyle })
    .eq("tenant_id", tenantId)
    .eq("id", clientId);

  if (error) {
    throw new Error(`Failed to refine client profile ${clientId}: ${error.message}`);
  }
}

export async function listClientProfiles(tenantId: string): Promise<ClientProfile[]> {
  const { data, error } = await getSupabaseClient()
    .from("client_profiles")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list client profiles: ${error.message}`);
  }
  return data.map(toClientProfile);
}

// ---------------------------------------------------------------------------
// appointments
// ---------------------------------------------------------------------------

/**
 * Thrown when a booking attempt loses a race for a slot — either
 * googleCalendarEngine.ts's own application-level re-check catches it
 * first, or (if two requests land within the same few milliseconds and
 * both pass that check) the database itself does: 020_appointments_no_overlap.sql
 * adds a GiST exclusion constraint that makes two overlapping *confirmed*
 * appointments for the same tenant physically impossible to insert,
 * caught below via Postgres error code 23P01 (exclusion_violation). Same
 * error type either way, so groqAgent.ts's handling doesn't need to know
 * which layer caught it.
 */
export class SlotNoLongerAvailableError extends Error {}

/** Postgres error code for "conflicting key value violates exclusion constraint" — see 020_appointments_no_overlap.sql. */
const POSTGRES_EXCLUSION_VIOLATION = "23P01";

export async function insertAppointment(input: {
  tenantId: string;
  clientId: string | null;
  googleEventId: string | null;
  serviceType: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  bookingChannel: BookingChannel;
}): Promise<Appointment> {
  const { data, error } = await getSupabaseClient()
    .from("appointments")
    .insert({
      tenant_id: input.tenantId,
      client_id: input.clientId,
      google_event_id: input.googleEventId,
      service_type: input.serviceType,
      start_time: input.startTime,
      end_time: input.endTime,
      status: input.status,
      booking_channel: input.bookingChannel,
    })
    .select("*")
    .single();

  if (error?.code === POSTGRES_EXCLUSION_VIOLATION) {
    throw new SlotNoLongerAvailableError(
      `The ${input.startTime}–${input.endTime} slot is no longer available — it was booked by someone else in the meantime.`,
    );
  }
  if (error || !data) {
    throw new Error(`Failed to insert appointment: ${error?.message ?? "unknown error"}`);
  }
  return toAppointment(data);
}

export async function getAppointmentById(tenantId: string, appointmentId: string): Promise<Appointment | null> {
  const { data, error } = await getSupabaseClient()
    .from("appointments")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", appointmentId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load appointment ${appointmentId}: ${error.message}`);
  }
  return data ? toAppointment(data) : null;
}

/**
 * Looks up an appointment by id alone, without a known tenant to scope by.
 * Only for internal system paths (e.g. the notification dispatcher, which
 * receives just an appointment id) that run with the service-role client —
 * never expose this un-scoped lookup on a tenant-facing API route.
 */
export async function getAppointmentByIdUnscoped(appointmentId: string): Promise<Appointment | null> {
  const { data, error } = await getSupabaseClient().from("appointments").select("*").eq("id", appointmentId).maybeSingle();

  if (error) {
    throw new Error(`Failed to load appointment ${appointmentId}: ${error.message}`);
  }
  return data ? toAppointment(data) : null;
}

export async function updateAppointmentStatus(
  tenantId: string,
  appointmentId: string,
  status: AppointmentStatus,
): Promise<Appointment> {
  const { data, error } = await getSupabaseClient()
    .from("appointments")
    .update({ status })
    .eq("tenant_id", tenantId)
    .eq("id", appointmentId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to update appointment status: ${error?.message ?? "unknown error"}`);
  }
  return toAppointment(data);
}

/** Lists appointments for a tenant within a UTC instant range, e.g. one calendar day's window. */
export async function listAppointmentsInRange(
  tenantId: string,
  startIso: string,
  endIso: string,
): Promise<Appointment[]> {
  const { data, error } = await getSupabaseClient()
    .from("appointments")
    .select("*")
    .eq("tenant_id", tenantId)
    .lt("start_time", endIso)
    .gt("end_time", startIso)
    .order("start_time", { ascending: true });

  if (error) {
    throw new Error(`Failed to list appointments in range: ${error.message}`);
  }
  return data.map(toAppointment);
}

export interface ListAppointmentsFilters {
  status?: AppointmentStatus;
  fromIso?: string;
  toIso?: string;
}

export async function listAppointments(tenantId: string, filters: ListAppointmentsFilters): Promise<Appointment[]> {
  let query = getSupabaseClient().from("appointments").select("*").eq("tenant_id", tenantId);

  if (filters.status) {
    query = query.eq("status", filters.status);
  }
  if (filters.fromIso) {
    query = query.gte("start_time", filters.fromIso);
  }
  if (filters.toIso) {
    query = query.lte("start_time", filters.toIso);
  }

  const { data, error } = await query.order("start_time", { ascending: true });
  if (error) {
    throw new Error(`Failed to list appointments: ${error.message}`);
  }
  return data.map(toAppointment);
}

export async function countAppointments(tenantId: string, status?: AppointmentStatus): Promise<number> {
  let query = getSupabaseClient()
    .from("appointments")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  if (status) {
    query = query.eq("status", status);
  }

  const { count, error } = await query;
  if (error) {
    throw new Error(`Failed to count appointments: ${error.message}`);
  }
  return count ?? 0;
}

/**
 * Atomically "claims" appointments whose `start_time` falls in
 * [windowStartIso, windowEndIso) and whose reminder flag is still false —
 * in one statement, flipping the flag to true AND returning only the rows
 * this call actually claimed.
 *
 * This is what makes concurrent scheduler runs safe without a separate
 * advisory lock: Postgres row-locks matching rows for the duration of the
 * UPDATE, so if two callers race on the same appointment, the loser's
 * WHERE clause simply no longer matches once the winner commits (the flag
 * is already true) — it gets zero rows back for that appointment, not a
 * duplicate. An advisory lock taken via a separate RPC round-trip would
 * actually be *less* safe here, since PostgREST/Supabase's connection
 * pooling means "acquire" and "release" calls aren't guaranteed to land on
 * the same underlying session.
 */
async function claimAppointmentsByFlag(
  flagColumn: "reminder_24h_sent" | "reminder_2h_sent",
  windowStartIso: string,
  windowEndIso: string,
): Promise<Appointment[]> {
  // A computed property key (`{ [flagColumn]: true }`) can't be checked
  // against the Update type's specific literal shape, so branch instead of
  // building the patch dynamically.
  const client = getSupabaseClient()
    .from("appointments")
    .update(flagColumn === "reminder_24h_sent" ? { reminder_24h_sent: true } : { reminder_2h_sent: true })
    .eq(flagColumn, false)
    .eq("status", "confirmed")
    .gte("start_time", windowStartIso)
    .lt("start_time", windowEndIso);

  const { data, error } = await client.select("*");

  if (error) {
    throw new Error(`Failed to claim appointments for ${flagColumn}: ${error.message}`);
  }
  return (data ?? []).map(toAppointment);
}

export function claimAppointmentsFor24hReminder(windowStartIso: string, windowEndIso: string): Promise<Appointment[]> {
  return claimAppointmentsByFlag("reminder_24h_sent", windowStartIso, windowEndIso);
}

export function claimAppointmentsFor2hReminder(windowStartIso: string, windowEndIso: string): Promise<Appointment[]> {
  return claimAppointmentsByFlag("reminder_2h_sent", windowStartIso, windowEndIso);
}

/** Same claim pattern, keyed on `end_time` instead of `start_time` — appointments that just finished. */
export async function claimAppointmentsForFeedback(windowStartIso: string, windowEndIso: string): Promise<Appointment[]> {
  const { data, error } = await getSupabaseClient()
    .from("appointments")
    .update({ feedback_requested: true })
    .eq("feedback_requested", false)
    .eq("status", "confirmed")
    .gte("end_time", windowStartIso)
    .lt("end_time", windowEndIso)
    .select("*");

  if (error) {
    throw new Error(`Failed to claim appointments for feedback: ${error.message}`);
  }
  return (data ?? []).map(toAppointment);
}

// ---------------------------------------------------------------------------
// conversation_logs
// ---------------------------------------------------------------------------

export async function insertConversationLog(entry: {
  tenantId: string;
  clientId: string;
  message: string;
  formalityScore: FiveScale;
  urgency: FiveScale;
  sentiment: Sentiment;
  toneNote: string;
}): Promise<void> {
  const { error } = await getSupabaseClient().from("conversation_logs").insert({
    tenant_id: entry.tenantId,
    client_id: entry.clientId,
    message: entry.message,
    formality_score: entry.formalityScore,
    urgency: entry.urgency,
    sentiment: entry.sentiment,
    tone_note: entry.toneNote,
  });

  if (error) {
    throw new Error(`Failed to insert conversation log: ${error.message}`);
  }
}

/**
 * Active blacklisted-pattern rules for the Threat Sentinel
 * (src/security/threatSentinel.ts), which caches this list in memory for
 * a short TTL rather than calling it per request.
 */
export async function getActiveBlacklistedPatterns(): Promise<BlacklistedPattern[]> {
  const { data, error } = await getSupabaseClient()
    .from("blacklisted_patterns")
    .select("*")
    .eq("is_active", true)
    .order("severity", { ascending: false });

  if (error) {
    throw new Error(`Failed to load blacklisted patterns: ${error.message}`);
  }
  return (data ?? []).map(toBlacklistedPattern);
}

/**
 * Fire-and-forget from the caller's perspective (src/security/threatSentinel.ts
 * always wraps this in a .catch that only logs — a logging failure must
 * never block or fail the actual chat/booking request it's auditing).
 */
export async function insertSecurityLog(entry: {
  ipAddress: string;
  tenantId?: string | null;
  channel: SecurityChannel;
  rawPrompt: string;
  threatScore: number;
  threatCategory: ThreatCategory;
  matchedPattern?: string | null;
  status: SecurityLogStatus;
}): Promise<void> {
  const { error } = await getSupabaseClient().from("security_logs").insert({
    ip_address: entry.ipAddress,
    tenant_id: entry.tenantId ?? null,
    channel: entry.channel,
    raw_prompt: entry.rawPrompt,
    threat_score: entry.threatScore,
    threat_category: entry.threatCategory,
    matched_pattern: entry.matchedPattern ?? null,
    status: entry.status,
  });

  if (error) {
    throw new Error(`Failed to insert security log: ${error.message}`);
  }
}

export async function getRecentConversationLogs(clientId: string, limit: number): Promise<ConversationLogEntry[]> {
  const { data, error } = await getSupabaseClient()
    .from("conversation_logs")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load conversation logs for client ${clientId}: ${error.message}`);
  }
  return (data ?? []).map(toConversationLogEntry);
}

export interface AppointmentDateFilters {
  fromIso?: string;
  toIso?: string;
}

/** One `count(*)` query per channel, run in parallel — cheaper than fetching full rows just to group them client-side. */
export async function countAppointmentsByChannel(
  tenantId: string,
  filters: AppointmentDateFilters = {},
): Promise<Partial<Record<BookingChannel, number>>> {
  const channels: BookingChannel[] = ["ai_chat", "ai_voice", "staff_manual"];

  const counts = await Promise.all(
    channels.map(async (channel) => {
      let query = getSupabaseClient()
        .from("appointments")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("booking_channel", channel);
      if (filters.fromIso) query = query.gte("start_time", filters.fromIso);
      if (filters.toIso) query = query.lte("start_time", filters.toIso);

      const { count, error } = await query;
      if (error) {
        throw new Error(`Failed to count appointments for channel ${channel}: ${error.message}`);
      }
      return [channel, count ?? 0] as const;
    }),
  );

  return Object.fromEntries(counts);
}

// ---------------------------------------------------------------------------
// call_transcripts
// ---------------------------------------------------------------------------

export async function insertCallTranscript(input: {
  tenantId: string;
  clientId: string | null;
  appointmentId: string | null;
  callSid: string;
  transcript: string;
  durationSeconds: number;
}): Promise<CallTranscriptRecord> {
  const { data, error } = await getSupabaseClient()
    .from("call_transcripts")
    .insert({
      tenant_id: input.tenantId,
      client_id: input.clientId,
      appointment_id: input.appointmentId,
      call_sid: input.callSid,
      transcript: input.transcript,
      duration_seconds: input.durationSeconds,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to insert call transcript: ${error?.message ?? "unknown error"}`);
  }
  return toCallTranscriptRecord(data);
}

// ---------------------------------------------------------------------------
// analytics (009_analytics_views.sql)
// ---------------------------------------------------------------------------

export async function getTenantDailyStats(tenantId: string, sinceIso?: string): Promise<TenantDailyStat[]> {
  let query = getSupabaseClient().from("v_tenant_daily_stats").select("*").eq("tenant_id", tenantId);
  if (sinceIso) {
    query = query.gte("day", sinceIso);
  }

  const { data, error } = await query.order("day", { ascending: true });
  if (error) {
    throw new Error(`Failed to load daily stats for tenant ${tenantId}: ${error.message}`);
  }
  return (data ?? []).map(toTenantDailyStat);
}

const SENTIMENTS: readonly Sentiment[] = ["positive", "neutral", "negative", "frustrated"];

function isToneDistributionPayload(value: unknown): value is { formality: Record<string, number>; sentiment: Record<string, number> } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["formality"] === "object" && candidate["formality"] !== null && typeof candidate["sentiment"] === "object" && candidate["sentiment"] !== null;
}

export async function getToneDistribution(tenantId: string): Promise<ToneDistribution> {
  const { data, error } = await getSupabaseClient().rpc("get_tone_distribution", { p_tenant_id: tenantId });
  if (error) {
    throw new Error(`Failed to load tone distribution for tenant ${tenantId}: ${error.message}`);
  }
  if (!isToneDistributionPayload(data)) {
    throw new Error("get_tone_distribution RPC returned an unexpected shape.");
  }

  const sentiment: Partial<Record<Sentiment, number>> = {};
  for (const key of SENTIMENTS) {
    const count = data.sentiment[key];
    if (typeof count === "number") {
      sentiment[key] = count;
    }
  }

  return { formality: data.formality, sentiment };
}

// ---------------------------------------------------------------------------
// push_subscriptions
// ---------------------------------------------------------------------------

export async function upsertPushSubscription(
  userId: string,
  platform: PushPlatform,
  target: Record<string, unknown>,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("push_subscriptions")
    .upsert({ user_id: userId, platform, target }, { onConflict: "user_id,platform" });

  if (error) {
    throw new Error(`Failed to save push subscription: ${error.message}`);
  }
}

export async function getPushSubscription(
  userId: string,
  platform: PushPlatform,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await getSupabaseClient()
    .from("push_subscriptions")
    .select("target")
    .eq("user_id", userId)
    .eq("platform", platform)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load push subscription: ${error.message}`);
  }
  return data ? data.target : null;
}

// ---------------------------------------------------------------------------
// services (supabase/migrations/015_services_catalog.sql)
// ---------------------------------------------------------------------------

export interface ListServicesFilters {
  /** Defaults to returning both — set true/false to filter, e.g. the dashboard's active/inactive toggle vs. the AI prompt only ever wanting active ones. */
  activeOnly?: boolean;
}

export async function listServices(tenantId: string, filters: ListServicesFilters = {}): Promise<Service[]> {
  let query = getSupabaseClient().from("services").select("*").eq("tenant_id", tenantId).order("name", { ascending: true });
  if (filters.activeOnly) {
    query = query.eq("is_active", true);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to list services for tenant ${tenantId}: ${error.message}`);
  }
  return (data ?? []).map(toService);
}

export async function insertService(input: {
  tenantId: string;
  name: string;
  durationMinutes: number;
  priceMinorUnits: number;
  currency?: Currency;
  description?: string | null;
  isActive?: boolean;
}): Promise<Service> {
  const { data, error } = await getSupabaseClient()
    .from("services")
    .insert({
      tenant_id: input.tenantId,
      name: input.name,
      duration_minutes: input.durationMinutes,
      price_minor_units: input.priceMinorUnits,
      currency: input.currency ?? "RON",
      description: input.description ?? null,
      is_active: input.isActive ?? true,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create service: ${error?.message ?? "unknown error"}`);
  }
  return toService(data);
}

/** Scoped by tenantId as well as id (not just id) so one tenant can never accidentally update another's service by guessing/enumerating ids — the same defense-in-depth pattern as updateAppointmentStatus. */
export async function updateService(
  tenantId: string,
  serviceId: string,
  patch: Partial<{
    name: string;
    durationMinutes: number;
    priceMinorUnits: number;
    currency: Currency;
    description: string | null;
    isActive: boolean;
  }>,
): Promise<Service> {
  const { data, error } = await getSupabaseClient()
    .from("services")
    .update({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.durationMinutes !== undefined ? { duration_minutes: patch.durationMinutes } : {}),
      ...(patch.priceMinorUnits !== undefined ? { price_minor_units: patch.priceMinorUnits } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.isActive !== undefined ? { is_active: patch.isActive } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", serviceId)
    .eq("tenant_id", tenantId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to update service ${serviceId}: ${error?.message ?? "not found"}`);
  }
  return toService(data);
}

export async function deleteService(tenantId: string, serviceId: string): Promise<void> {
  const { error } = await getSupabaseClient().from("services").delete().eq("id", serviceId).eq("tenant_id", tenantId);
  if (error) {
    throw new Error(`Failed to delete service ${serviceId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// tenant_faqs (supabase/migrations/019_tenant_tone_and_faqs.sql) — same
// shape as the services accessors immediately above.
// ---------------------------------------------------------------------------

export interface ListFaqsFilters {
  /** Defaults to returning both — the AI prompt only ever wants active ones, the dashboard's FAQ manager wants both. */
  activeOnly?: boolean;
}

export async function listFaqs(tenantId: string, filters: ListFaqsFilters = {}): Promise<Faq[]> {
  let query = getSupabaseClient()
    .from("tenant_faqs")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("display_order", { ascending: true });
  if (filters.activeOnly) {
    query = query.eq("is_active", true);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to list FAQs for tenant ${tenantId}: ${error.message}`);
  }
  return (data ?? []).map(toFaq);
}

export async function insertFaq(input: {
  tenantId: string;
  question: string;
  answer: string;
  displayOrder?: number;
  isActive?: boolean;
}): Promise<Faq> {
  const { data, error } = await getSupabaseClient()
    .from("tenant_faqs")
    .insert({
      tenant_id: input.tenantId,
      question: input.question,
      answer: input.answer,
      display_order: input.displayOrder ?? 0,
      is_active: input.isActive ?? true,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create FAQ: ${error?.message ?? "unknown error"}`);
  }
  return toFaq(data);
}

/** Scoped by tenantId as well as id, same defense-in-depth reasoning as updateService. */
export async function updateFaq(
  tenantId: string,
  faqId: string,
  patch: Partial<{ question: string; answer: string; displayOrder: number; isActive: boolean }>,
): Promise<Faq> {
  const { data, error } = await getSupabaseClient()
    .from("tenant_faqs")
    .update({
      ...(patch.question !== undefined ? { question: patch.question } : {}),
      ...(patch.answer !== undefined ? { answer: patch.answer } : {}),
      ...(patch.displayOrder !== undefined ? { display_order: patch.displayOrder } : {}),
      ...(patch.isActive !== undefined ? { is_active: patch.isActive } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", faqId)
    .eq("tenant_id", tenantId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to update FAQ ${faqId}: ${error?.message ?? "not found"}`);
  }
  return toFaq(data);
}

export async function deleteFaq(tenantId: string, faqId: string): Promise<void> {
  const { error } = await getSupabaseClient().from("tenant_faqs").delete().eq("id", faqId).eq("tenant_id", tenantId);
  if (error) {
    throw new Error(`Failed to delete FAQ ${faqId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// schema introspection (src/utils/prodChecklist.ts)
// ---------------------------------------------------------------------------

export async function listIndexNames(): Promise<string[]> {
  const { data, error } = await getSupabaseClient().rpc("list_index_names");
  if (error) {
    throw new Error(`Failed to list index names: ${error.message}`);
  }
  return data ?? [];
}
