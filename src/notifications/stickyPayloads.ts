/**
 * Platform-specific "sticky" notification payload builders. These are pure
 * functions — they shape data, they don't send anything (see `androidPush.ts`,
 * `iosPush.ts`, and `webPush.ts` for the senders that consume them).
 */
import type { Appointment, AppointmentStatus, Tenant } from "../types/index.js";

// ---------------------------------------------------------------------------
// Android — NotificationCompat.Builder-shaped config
// ---------------------------------------------------------------------------

export interface AndroidNotificationConfig {
  channelId: string;
  /** Maps to NotificationCompat.CATEGORY_EVENT. */
  category: "EVENT";
  /** Maps to NotificationCompat.PRIORITY_HIGH. */
  priority: "HIGH";
  /** Maps to Builder#setOngoing(true), which sets FLAG_ONGOING_EVENT. */
  persistent: true;
  title: string;
  body: string;
  smallIcon: string;
  data: Record<string, string>;
}

function androidCopyFor(appointment: Appointment): { title: string; body: string } {
  const when = new Date(appointment.startTime).toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

  switch (appointment.status) {
    case "cancelled":
      return { title: "Appointment cancelled", body: `Your ${appointment.serviceType} on ${when} was cancelled.` };
    case "rescheduled":
      return { title: "Appointment rescheduled", body: `Your ${appointment.serviceType} is now ${when}.` };
    case "confirmed":
    default:
      return { title: "Upcoming appointment", body: `${appointment.serviceType} — ${when}` };
  }
}

export function buildAndroidOngoingNotification(appointment: Appointment): AndroidNotificationConfig {
  const { title, body } = androidCopyFor(appointment);
  return {
    channelId: `tenant_${appointment.tenantId}_appointments`,
    category: "EVENT",
    priority: "HIGH",
    persistent: true,
    title,
    body,
    smallIcon: "ic_stat_appointment",
    data: {
      tenantId: appointment.tenantId,
      appointmentId: appointment.id,
      status: appointment.status,
      startTime: appointment.startTime,
    },
  };
}

// ---------------------------------------------------------------------------
// iOS — ActivityKit Live Activity content state
// ---------------------------------------------------------------------------

export interface IOSLiveActivityState {
  clinicName: string;
  /** Unix seconds. */
  appointmentTimestamp: number;
  countdownMinutes: number;
  locationAddress: string;
  status: AppointmentStatus;
}

/**
 * `locationAddress` has no home in the schema (tenants don't store an
 * address), so the caller must supply it — typically read back from the
 * Google Calendar event's `location` field via
 * `googleCalendarEngine.getCalendarEventLocation`. Passing "" is valid: it
 * means the event genuinely has no location set, not that this function
 * guessed.
 */
export function buildIOSLiveActivityPayload(
  appointment: Appointment,
  tenant: Tenant,
  locationAddress: string,
): IOSLiveActivityState {
  const appointmentTimestamp = Math.floor(new Date(appointment.startTime).getTime() / 1000);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const countdownMinutes = Math.max(0, Math.round((appointmentTimestamp - nowSeconds) / 60));

  return {
    clinicName: tenant.name,
    appointmentTimestamp,
    countdownMinutes,
    locationAddress,
    status: appointment.status,
  };
}
