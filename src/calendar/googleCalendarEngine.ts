/**
 * Google Calendar API v3 REST integration: free/busy lookups, derived open
 * slots (working hours minus Google busy intervals minus already-booked
 * appointments), event insertion, and cancellation.
 *
 * Authentication is resolved per-tenant (see resolveGoogleAccessToken):
 * a tenant that has connected their own Google account via OAuth
 * (017_google_oauth_calendar.sql, src/auth/googleOAuthTokens.ts) uses
 * that token, so their calendar never needs to be shared with anything.
 * Every other tenant falls back to the platform's shared service account
 * exactly as before — that tenant's calendar must be shared with the
 * service account's client_email as "Make changes to events". This
 * fallback is why every existing caller (groqAgent.ts's booking tools,
 * webhooks.ts) keeps working unchanged: the auth source is decided here,
 * not by the caller.
 *
 * LOCAL-ONLY DEGRADED MODE: if a tenant has neither an OAuth connection
 * nor the platform service account configured at all (see
 * isGoogleCalendarAvailable), getAvailableSlots/bookSlot don't fail —
 * they just skip the external Google step entirely and compute
 * availability from what's actually real and already available without
 * Google: the tenant's configured working hours and the appointments
 * already sitting in Supabase (listAppointmentsInRange). This is
 * deliberately NOT a hardcoded/canned slot list — a fixed list of
 * "typical" open times would drift from real working hours and, worse,
 * from real existing bookings, risking the AI confidently offering a
 * slot that's already taken. Booking in this mode writes the appointment
 * with `googleEventId: null` (already a nullable column) and simply
 * never creates a Google event — nothing about the local Supabase write
 * changes.
 */
import { getValidGoogleOAuthAccessToken } from "../auth/googleOAuthTokens.js";
import {
  getGoogleAccessToken,
  isGoogleServiceAccountConfigured,
  loadGoogleServiceAccountCredentials,
} from "../auth/googleServiceAccount.js";
import {
  getOrCreateClientProfile,
  getTenantById,
  insertAppointment,
  listAppointmentsInRange,
  SlotNoLongerAvailableError,
  updateClientName,
} from "../db/supabase.js";
import type { AppointmentRequest, BookingConfirmation, Slot, Weekday, WeekdayHours } from "../types/index.js";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"] as const;
const SLOT_INTERVAL_MINUTES = 30;

const WEEKDAYS_BY_UTC_INDEX: readonly Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

// ---------------------------------------------------------------------------
// Authenticated fetch
// ---------------------------------------------------------------------------

/** Tenant's own connected Google account if they have one, otherwise the platform service account — see this file's header comment. */
async function resolveGoogleAccessToken(tenantId: string): Promise<string> {
  const oauthToken = await getValidGoogleOAuthAccessToken(tenantId);
  if (oauthToken) {
    return oauthToken;
  }
  const credentials = loadGoogleServiceAccountCredentials();
  return getGoogleAccessToken(credentials, CALENDAR_SCOPES);
}

/**
 * No-throw check for whether *any* Google auth source is usable for this
 * tenant right now — an OAuth connection, or the platform service
 * account being configured at all. getAvailableSlots/bookSlot check this
 * first and skip straight to local-only mode rather than attempting a
 * call that would just throw (see this file's header comment).
 */
async function isGoogleCalendarAvailable(tenantId: string): Promise<boolean> {
  const oauthToken = await getValidGoogleOAuthAccessToken(tenantId);
  return oauthToken !== null || isGoogleServiceAccountConfigured();
}

async function authorizedFetch(tenantId: string, url: string, init: RequestInit): Promise<Response> {
  const accessToken = await resolveGoogleAccessToken(tenantId);

  const response = await fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google Calendar API request failed (${response.status}): ${errorBody}`);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Timezone-correct wall-clock <-> UTC conversion
// ---------------------------------------------------------------------------

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Converts a civil wall-clock time (e.g. "09:00 on 2026-08-15 in
 * America/New_York") to the UTC instant it represents, correctly handling
 * each IANA zone's offset — including DST — for that specific date. Uses
 * the standard two-pass `Intl.DateTimeFormat` technique so no date-library
 * dependency is needed.
 */
function zonedWallTimeToUtc(dateStr: string, hourMinute: string, timeZone: string): Date {
  const initialGuess = new Date(`${dateStr}T${hourMinute}:00.000Z`);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(initialGuess);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";

  const wallClockAsUtc = Date.UTC(
    Number(part("year")),
    Number(part("month")) - 1,
    Number(part("day")),
    Number(part("hour")),
    Number(part("minute")),
    Number(part("second")),
  );
  const offsetMs = wallClockAsUtc - initialGuess.getTime();
  return new Date(initialGuess.getTime() - offsetMs);
}

function weekdayOf(dateStr: string): Weekday {
  const utcIndex = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  const weekday = WEEKDAYS_BY_UTC_INDEX[utcIndex];
  if (!weekday) {
    throw new Error(`Could not determine weekday for date "${dateStr}".`);
  }
  return weekday;
}

// ---------------------------------------------------------------------------
// Free/busy
// ---------------------------------------------------------------------------

interface BusyInterval {
  startMs: number;
  endMs: number;
}

interface FreeBusyResponse {
  calendars: Record<string, { busy: { start: string; end: string }[]; errors?: { reason: string }[] }>;
}

function isFreeBusyResponse(value: unknown): value is FreeBusyResponse {
  return typeof value === "object" && value !== null && "calendars" in value;
}

async function getGoogleBusyIntervals(tenantId: string, calendarId: string, timeMinIso: string, timeMaxIso: string): Promise<BusyInterval[]> {
  const response = await authorizedFetch(tenantId, `${CALENDAR_API_BASE}/freeBusy`, {
    method: "POST",
    body: JSON.stringify({ timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: calendarId }] }),
  });

  const payload: unknown = await response.json();
  if (!isFreeBusyResponse(payload)) {
    throw new Error("Google Calendar freeBusy response had an unexpected shape.");
  }

  const calendarEntry = payload.calendars[calendarId];
  if (!calendarEntry) {
    return [];
  }
  if (calendarEntry.errors && calendarEntry.errors.length > 0) {
    throw new Error(`Google Calendar freeBusy returned errors for ${calendarId}: ${JSON.stringify(calendarEntry.errors)}`);
  }
  return calendarEntry.busy.map((interval) => ({
    startMs: new Date(interval.start).getTime(),
    endMs: new Date(interval.end).getTime(),
  }));
}

function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes bookable slots for a single calendar day: the tenant's working
 * hours for that weekday, minus Google Calendar busy intervals, minus
 * appointments already recorded in Supabase (defense in depth in case a
 * booking exists in our database but hasn't propagated to Calendar yet).
 */
export async function getAvailableSlots(tenantId: string, date: string, durationMinutes: number): Promise<Slot[]> {
  if (!DATE_ONLY_PATTERN.test(date)) {
    throw new Error(`Invalid date "${date}"; expected YYYY-MM-DD.`);
  }
  if (durationMinutes <= 0) {
    throw new Error(`Invalid durationMinutes "${durationMinutes}"; must be positive.`);
  }

  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    throw new Error(`Unknown tenant: ${tenantId}`);
  }

  const hours: WeekdayHours | null = tenant.workingHours[weekdayOf(date)];
  if (!hours) {
    return [];
  }

  const windowStart = zonedWallTimeToUtc(date, hours.start, tenant.timezone);
  const windowEnd = zonedWallTimeToUtc(date, hours.end, tenant.timezone);
  if (Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime()) || windowEnd <= windowStart) {
    throw new Error(`Invalid working hours or timezone for tenant ${tenantId} on ${date}.`);
  }

  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();

  const calendarConnected = await isGoogleCalendarAvailable(tenantId);
  if (!calendarConnected) {
    console.warn(
      `[googleCalendarEngine] No Google Calendar connection for tenant ${tenantId} — computing availability from working hours + local Supabase appointments only.`,
    );
  }
  const [googleBusy, existingAppointments] = await Promise.all([
    calendarConnected ? getGoogleBusyIntervals(tenantId, tenant.googleCalendarId, windowStartIso, windowEndIso) : Promise.resolve<BusyInterval[]>([]),
    listAppointmentsInRange(tenantId, windowStartIso, windowEndIso),
  ]);

  const appointmentBusy: BusyInterval[] = existingAppointments
    .filter((appointment) => appointment.status === "confirmed")
    .map((appointment) => ({
      startMs: new Date(appointment.startTime).getTime(),
      endMs: new Date(appointment.endTime).getTime(),
    }));

  const busyIntervals = [...googleBusy, ...appointmentBusy];

  const windowStartMs = windowStart.getTime();
  const windowEndMs = windowEnd.getTime();
  const stepMs = SLOT_INTERVAL_MINUTES * 60 * 1000;
  const durationMs = durationMinutes * 60 * 1000;

  const slots: Slot[] = [];
  for (let slotStartMs = windowStartMs; slotStartMs + durationMs <= windowEndMs; slotStartMs += stepMs) {
    const slotEndMs = slotStartMs + durationMs;
    const isBusy = busyIntervals.some((busy) => intervalsOverlap(slotStartMs, slotEndMs, busy.startMs, busy.endMs));
    slots.push({
      start: new Date(slotStartMs).toISOString(),
      end: new Date(slotEndMs).toISOString(),
      available: !isBusy,
    });
  }
  return slots;
}

interface CalendarEventResponse {
  id: string;
  htmlLink: string;
}

function isCalendarEventResponse(value: unknown): value is CalendarEventResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { htmlLink?: unknown }).htmlLink === "string"
  );
}

/**
 * Books a slot: creates the Google Calendar event, then records the
 * appointment (and the client profile, if new) in Supabase. The calendar
 * write happens first — if it fails, nothing is persisted; if the
 * subsequent Supabase insert fails, the caller receives that error and the
 * calendar event is left in place for manual reconciliation rather than
 * silently losing a confirmed slot.
 *
 * "Respects manual calendar updates made by human staff" (the original
 * ask) already holds for availability today without any extra plumbing:
 * a staff member deleting/moving an event directly in Google Calendar
 * changes what the next freeBusy query (getGoogleBusyIntervals, called
 * from getAvailableSlots) sees, since Google is the source of truth
 * there. What's genuinely missing is the reverse notice — this app's own
 * `appointments.status` doesn't yet learn about a manual cancel/move on
 * its own; that needs Google push-notification webhooks (calendar.events.watch),
 * which need a public HTTPS URL this environment doesn't have. Deliberately
 * not built this pass — see the conversation this shipped in for why.
 */
export async function bookSlot(tenantId: string, appointmentData: AppointmentRequest): Promise<BookingConfirmation> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    throw new Error(`Unknown tenant: ${tenantId}`);
  }

  const startTime = new Date(appointmentData.startTime);
  if (Number.isNaN(startTime.getTime())) {
    throw new Error(`"${appointmentData.startTime}" is not a valid ISO 8601 datetime.`);
  }
  if (appointmentData.durationMinutes <= 0) {
    throw new Error(`Invalid durationMinutes "${appointmentData.durationMinutes}"; must be positive.`);
  }
  const endTime = new Date(startTime.getTime() + appointmentData.durationMinutes * 60 * 1000);

  // Re-check for a conflict right here, server-side, immediately before
  // writing — NOT relying on the model having called check_available_slots
  // first and honored the result. It's only a hint to the model, not an
  // enforced precondition: nothing stopped the model from calling
  // create_appointment for a slot it already knows is taken (or one
  // another concurrent conversation just took a moment ago), and live
  // testing proved exactly that — two different clients both confirmed
  // into the identical slot before this check existed. Same
  // "confirmed appointments only" filter and interval-overlap logic as
  // getAvailableSlots, just re-run at the moment that actually matters.
  const overlapping = (await listAppointmentsInRange(tenantId, startTime.toISOString(), endTime.toISOString())).filter(
    (appointment) =>
      appointment.status === "confirmed" &&
      intervalsOverlap(startTime.getTime(), endTime.getTime(), new Date(appointment.startTime).getTime(), new Date(appointment.endTime).getTime()),
  );
  if (overlapping.length > 0) {
    throw new SlotNoLongerAvailableError(
      `The ${startTime.toISOString()}–${endTime.toISOString()} slot is no longer available — it was booked by someone else in the meantime.`,
    );
  }

  const clientProfile = await getOrCreateClientProfile(tenantId, appointmentData.phoneNumber);
  if (appointmentData.fullName && clientProfile.fullName !== appointmentData.fullName) {
    await updateClientName(tenantId, clientProfile.id, appointmentData.fullName);
  }

  // Local-only degraded mode (see this file's header comment): no Google
  // event is created, googleEventId stays null. The conflict check above
  // is what actually keeps this safe; the Supabase write below is
  // unaffected either way.
  let googleEventId: string | null = null;
  if (await isGoogleCalendarAvailable(tenantId)) {
    const response = await authorizedFetch(
      tenantId,
      `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(tenant.googleCalendarId)}/events`,
      {
        method: "POST",
        body: JSON.stringify({
          summary: `${appointmentData.serviceType} — ${appointmentData.fullName}`,
          description: `Booked via AI assistant. Contact: ${appointmentData.phoneNumber}`,
          start: { dateTime: startTime.toISOString(), timeZone: tenant.timezone },
          end: { dateTime: endTime.toISOString(), timeZone: tenant.timezone },
        }),
      },
    );

    const payload: unknown = await response.json();
    if (!isCalendarEventResponse(payload)) {
      throw new Error("Google Calendar event-insert response had an unexpected shape.");
    }
    googleEventId = payload.id;
  } else {
    console.warn(`[googleCalendarEngine] No Google Calendar connection for tenant ${tenantId} — booking locally only, no calendar event created.`);
  }

  const appointment = await insertAppointment({
    tenantId,
    clientId: clientProfile.id,
    googleEventId,
    serviceType: appointmentData.serviceType,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    status: "confirmed",
    bookingChannel: appointmentData.bookingChannel,
  });

  // eventId is typed non-null (BookingConfirmation) — for a local-only
  // booking there's no real Google event id to report, so this falls
  // back to the appointment's own id. Nothing downstream currently reads
  // BookingConfirmation.eventId for anything but display, so this is a
  // safe stand-in, not a fabricated Google identifier.
  return { appointmentId: appointment.id, eventId: googleEventId ?? appointment.id, startTime: startTime.toISOString() };
}

/** Deletes a Google Calendar event, e.g. as part of cancelling an appointment. Idempotent: a 404/410 (already gone) is not an error. */
export async function deleteCalendarEvent(tenantId: string, calendarId: string, eventId: string): Promise<void> {
  const accessToken = await resolveGoogleAccessToken(tenantId);

  const response = await fetch(`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok && response.status !== 404 && response.status !== 410) {
    const errorBody = await response.text();
    throw new Error(`Google Calendar event delete failed (${response.status}): ${errorBody}`);
  }
}

/**
 * Reads back the `location` string of a calendar event, if any was set.
 * This remains the iOS Live Activity payload builder's source for
 * `locationAddress` — tenants.address (016_tenant_business_info.sql) is
 * the business's own street address, not necessarily where a given
 * appointment happens, so it isn't a substitute for this per-event value.
 * An empty string means the event genuinely has no location set, not that
 * the lookup failed silently.
 */
export async function getCalendarEventLocation(tenantId: string, calendarId: string, eventId: string): Promise<string> {
  const response = await authorizedFetch(
    tenantId,
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "GET" },
  );
  const payload: unknown = await response.json();
  const location = (payload as { location?: unknown }).location;
  return typeof location === "string" ? location : "";
}
