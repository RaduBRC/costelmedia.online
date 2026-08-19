/**
 * Typed fetch client for the dashboard/chat frontend. Every call hits the
 * Express API under `/api` (proxied to the backend by Vite in dev, same
 * origin in production) — nothing here is mocked or stubbed.
 */
import { emitUnauthorized } from "./authEvents.js";
import { supabase } from "./supabaseClient.js";
import type {
  AnalyticsTimeframe,
  Appointment,
  AppointmentStatus,
  BusinessType,
  ClientProfile,
  Currency,
  Faq,
  ProcessMessageResult,
  Service,
  Slot,
  Tenant,
  TenantDashboardMetrics,
  ToneOfVoice,
  WorkingHours,
} from "../types/index.js";

export class ApiError extends Error {}

export interface HealthCheckResult {
  status: "ok" | "degraded" | "down";
  checks: {
    groq: { status: string; detail?: string };
    supabase: { status: string; detail?: string };
    googleCalendar: { status: string; detail?: string };
  };
  timestamp: string;
}

// Empty by default (relative /api/... requests) for same-origin
// deployments; set VITE_API_BASE_URL at build time when the frontend and
// backend are deployed to different origins (e.g. Vercel + Render).
// Exported for WidgetEmbedPanel.tsx, which needs the bare backend origin
// (not /api-prefixed) to build the <script src> for GET /widget.js.
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";

/**
 * 401 handling: a *proactive* refresh (Supabase's client does this on its
 * own timer before tokens expire) means a 401 reaching us here is unlikely
 * to be routine expiry — but to rule that race out, try exactly one
 * explicit refresh-and-retry before giving up. If the refresh itself fails,
 * or the retried request 401s again, the session is genuinely no longer
 * valid: emit the unauthorized event (AuthContext.tsx signs the user out)
 * and surface a clear message rather than a raw HTTP error.
 */
async function apiFetch<T>(path: string, init?: RequestInit, isRetry = false): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const response = await fetch(`${API_BASE_URL}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 401) {
    if (!isRetry) {
      const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
      if (!refreshError && refreshed.session) {
        return apiFetch<T>(path, init, true);
      }
    }
    emitUnauthorized();
    throw new ApiError("Your session has expired. Please sign in again.");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `Request to ${path} failed (${response.status}).`;
    throw new ApiError(message);
  }

  return payload as T;
}

export interface RegisterTenantInput {
  businessName: string;
  businessType: BusinessType;
  adminEmail: string;
  adminPassword: string;
}

export interface RegisterTenantResult {
  tenantId: string;
  adminUserId: string;
  message: string;
}

/**
 * POST /api/v1/tenants/register (src/api/tenantProvisioning.ts) — public,
 * no session exists yet at this point, so apiFetch simply sends no
 * Authorization header (its own logic already only adds one when a
 * session is present). Creating the account does NOT sign the caller in
 * — RegisterPage.tsx calls useAuth().login() right after this resolves.
 */
export function registerTenant(input: RegisterTenantInput): Promise<RegisterTenantResult> {
  return apiFetch<RegisterTenantResult>("/v1/tenants/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface OnboardTenantInput {
  businessName: string;
  businessType: BusinessType;
}

/** POST /api/v1/tenants/onboard — for an already-authenticated user (Google sign-in) who owns no tenant yet. See OnboardingPage.tsx. */
export function onboardTenant(input: OnboardTenantInput): Promise<{ tenantId: string; message: string }> {
  return apiFetch<{ tenantId: string; message: string }>("/v1/tenants/onboard", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getTenant(tenantId: string): Promise<Tenant> {
  return apiFetch<Tenant>(`/tenants/${encodeURIComponent(tenantId)}`);
}

/** GET /api/super-admin/tenants (src/api/routes/superAdmin.ts) — every tenant on the platform; requireSuperAdmin-gated server-side. */
export function getSuperAdminTenants(): Promise<Tenant[]> {
  return apiFetch<Tenant[]>("/super-admin/tenants");
}

export interface TenantSettingsPatch {
  name?: string;
  businessType?: BusinessType;
  workingHours?: WorkingHours;
  elevenlabsVoiceId?: string | null;
  systemPromptOverride?: string | null;
  greetingMessage?: string | null;
  publicPhoneNumber?: string | null;
  address?: string | null;
  toneOfVoice?: ToneOfVoice;
}

export function updateTenant(tenantId: string, patch: TenantSettingsPatch): Promise<Tenant> {
  return apiFetch<Tenant>(`/tenants/${encodeURIComponent(tenantId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  previewUrl: string | null;
  category: string | null;
}

export function listVoices(tenantId: string): Promise<ElevenLabsVoice[]> {
  return apiFetch<ElevenLabsVoice[]>(`/tenants/${encodeURIComponent(tenantId)}/voices`);
}

export interface GoogleCalendarConnectionStatus {
  connected: boolean;
  calendarId: string;
}

export function getGoogleCalendarStatus(tenantId: string): Promise<GoogleCalendarConnectionStatus> {
  return apiFetch<GoogleCalendarConnectionStatus>(`/tenants/${encodeURIComponent(tenantId)}/integrations/google/status`);
}

/** Returns the Google consent URL to navigate the browser to — the caller does `window.location.href = consentUrl` itself; see src/api/routes/googleIntegration.ts for why this can't just redirect server-side. */
export function getGoogleCalendarConsentUrl(tenantId: string): Promise<{ consentUrl: string }> {
  return apiFetch<{ consentUrl: string }>(`/tenants/${encodeURIComponent(tenantId)}/integrations/google/auth`);
}

export function disconnectGoogleCalendar(tenantId: string): Promise<void> {
  return apiFetch<void>(`/tenants/${encodeURIComponent(tenantId)}/integrations/google/disconnect`, { method: "DELETE" });
}

export function listServices(tenantId: string): Promise<Service[]> {
  return apiFetch<Service[]>(`/tenants/${encodeURIComponent(tenantId)}/services`);
}

export interface ServiceInput {
  name: string;
  durationMinutes: number;
  priceMinorUnits: number;
  currency: Currency;
  description: string | null;
  isActive: boolean;
}

export function createService(tenantId: string, input: ServiceInput): Promise<Service> {
  return apiFetch<Service>(`/tenants/${encodeURIComponent(tenantId)}/services`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function patchService(tenantId: string, serviceId: string, patch: Partial<ServiceInput>): Promise<Service> {
  return apiFetch<Service>(`/tenants/${encodeURIComponent(tenantId)}/services/${encodeURIComponent(serviceId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteService(tenantId: string, serviceId: string): Promise<void> {
  return apiFetch<void>(`/tenants/${encodeURIComponent(tenantId)}/services/${encodeURIComponent(serviceId)}`, {
    method: "DELETE",
  });
}

// No dedicated FAQ management UI yet (out of scope for this pass — see
// the conversation promptBuilder.ts's FAQ injection shipped in); these
// exist so the backend CRUD already built is actually reachable from the
// frontend the moment that UI is built, same shape as the services client
// functions above.
export function listFaqs(tenantId: string): Promise<Faq[]> {
  return apiFetch<Faq[]>(`/tenants/${encodeURIComponent(tenantId)}/faqs`);
}

export interface FaqInput {
  question: string;
  answer: string;
  displayOrder?: number;
  isActive?: boolean;
}

export function createFaq(tenantId: string, input: FaqInput): Promise<Faq> {
  return apiFetch<Faq>(`/tenants/${encodeURIComponent(tenantId)}/faqs`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function patchFaq(tenantId: string, faqId: string, patch: Partial<FaqInput>): Promise<Faq> {
  return apiFetch<Faq>(`/tenants/${encodeURIComponent(tenantId)}/faqs/${encodeURIComponent(faqId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteFaq(tenantId: string, faqId: string): Promise<void> {
  return apiFetch<void>(`/tenants/${encodeURIComponent(tenantId)}/faqs/${encodeURIComponent(faqId)}`, {
    method: "DELETE",
  });
}

export interface ListAppointmentsParams {
  status?: AppointmentStatus;
  from?: string;
  to?: string;
}

export function listAppointments(tenantId: string, params: ListAppointmentsParams = {}): Promise<Appointment[]> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return apiFetch<Appointment[]>(`/tenants/${encodeURIComponent(tenantId)}/appointments${suffix}`);
}

export function listClients(tenantId: string): Promise<ClientProfile[]> {
  return apiFetch<ClientProfile[]>(`/tenants/${encodeURIComponent(tenantId)}/clients`);
}

export function getAvailableSlots(tenantId: string, date: string, durationMinutes = 30): Promise<Slot[]> {
  const query = new URLSearchParams({ date, durationMinutes: String(durationMinutes) });
  return apiFetch<Slot[]>(`/tenants/${encodeURIComponent(tenantId)}/slots?${query.toString()}`);
}

export interface TenantMetrics {
  totalAppointments: number;
  availableSlotsToday: number;
  clientRetentionRate: number;
  totalClients: number;
}

export function getMetrics(tenantId: string): Promise<TenantMetrics> {
  return apiFetch<TenantMetrics>(`/tenants/${encodeURIComponent(tenantId)}/metrics`);
}

export function getDashboardAnalytics(tenantId: string, timeframe: AnalyticsTimeframe): Promise<TenantDashboardMetrics> {
  return apiFetch<TenantDashboardMetrics>(`/tenants/${encodeURIComponent(tenantId)}/analytics?timeframe=${timeframe}`);
}

/**
 * `channel` defaults to "ai_chat" server-side when omitted — only
 * VoiceCallSimulator.tsx passes "ai_voice", so any appointment this turn
 * books gets tagged the same way a real phone call's would.
 */
export function sendChatMessage(
  tenantId: string,
  clientPhone: string,
  message: string,
  channel?: "ai_chat" | "ai_voice",
): Promise<ProcessMessageResult> {
  return apiFetch<ProcessMessageResult>(`/tenants/${encodeURIComponent(tenantId)}/chat`, {
    method: "POST",
    body: JSON.stringify({ clientPhone, message, ...(channel ? { channel } : {}) }),
  });
}

/** Client-side ceiling on the whole /api/tts round-trip — longer than the server's own 5s ElevenLabs timeout (elevenLabsTts.ts's REQUEST_TIMEOUT_MS) so the server's timeout has a chance to fire first and return a clean ELEVENLABS_TIMEOUT response; this is the backstop for everything else (network stall to our own backend, the response never arriving at all). */
const TTS_CLIENT_TIMEOUT_MS = 8000;

/**
 * Thrown by synthesizeSpeech on any non-2xx response — `code` is the
 * server's stable error code (MISSING_KEYS, ELEVENLABS_TIMEOUT,
 * ELEVENLABS_FAILED, TTS_UNAVAILABLE, ...; see src/api/routes/tts.ts),
 * `"CLIENT_TIMEOUT"` if this request itself timed out before the server
 * even responded, or `"NETWORK_ERROR"` for anything else (offline, DNS,
 * CORS, ...). Callers (VoiceCallSimulator.tsx) log `code` + `message`
 * verbatim to their debug panel rather than a single flattened string, so
 * a failure is diagnosable on screen instead of just "something failed".
 */
export class TtsError extends ApiError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * POST /api/tts — returns synthesized speech as a playable audio Blob
 * (ElevenLabs mp3_44100_128 under the hood; see src/api/routes/tts.ts).
 * Not built on apiFetch<T> above: that helper always parses the response
 * body as JSON, which would corrupt binary audio data — this duplicates
 * just enough of it (session token, 401-retry-once) for a binary response
 * instead.
 */
export async function synthesizeSpeech(text: string, isRetry = false): Promise<Blob> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), TTS_CLIENT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ text }),
      signal: timeoutController.signal,
    });
  } catch (error) {
    if (timeoutController.signal.aborted) {
      throw new TtsError("CLIENT_TIMEOUT", `/api/tts did not respond within ${TTS_CLIENT_TIMEOUT_MS}ms.`);
    }
    throw new TtsError("NETWORK_ERROR", error instanceof Error ? error.message : "Network request to /api/tts failed.");
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 401 && !isRetry) {
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
    if (!refreshError && refreshed.session) {
      return synthesizeSpeech(text, true);
    }
  }

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    const code = typeof record?.["error"] === "string" ? record["error"] : `HTTP_${response.status}`;
    const message = typeof record?.["message"] === "string" ? record["message"] : `Text-to-speech request failed (${response.status}).`;
    throw new TtsError(code, message);
  }

  return response.blob();
}

/**
 * GET /health — unauthenticated, unprefixed (not under /api — see
 * src/server/app.ts's `app.use(healthRouter)`), so this bypasses apiFetch
 * entirely rather than teaching that helper about a one-off exception.
 * Backs DashboardLayout's "System Online" badge — real Groq/Supabase/
 * Google Calendar connectivity, not a decorative always-green dot.
 */
export async function getHealth(): Promise<HealthCheckResult> {
  const response = await fetch(`${API_BASE_URL}/health`);
  const payload = (await response.json()) as HealthCheckResult;
  return payload;
}
