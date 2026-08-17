/**
 * Aggregated tenant analytics: daily stats (from the v_tenant_daily_stats
 * view), tone/sentiment distribution (from the get_tone_distribution RPC),
 * and derived rates — retention, cancellation, AI-agent efficiency, and
 * slot utilization.
 *
 * Slot utilization is a deliberate approximation, not a live Google
 * Calendar query: computing *exact* per-day free/busy utilization over a
 * 7–30 day window would mean one Calendar API call per day in the range,
 * which is both slow (defeats "sub-50ms" for anything backed by it) and
 * needless spend against Google's rate limits for a dashboard number.
 * Instead it compares booked appointments against *potential* capacity
 * derived from the tenant's configured working hours — real data, just a
 * capacity model rather than a live calendar read.
 */
import { countAppointmentsByChannel, getTenantById, getTenantDailyStats, getToneDistribution, listAppointments } from "../db/supabase.js";
import type { AnalyticsTimeframe, Appointment, TenantDashboardMetrics, Weekday, WorkingHours } from "../types/index.js";

/** Shared by this module and the lightweight GET /metrics route — one implementation of "% of clients with 2+ visits", not two. */
export function computeClientRetentionRatePct(appointments: Pick<Appointment, "clientId">[]): number {
  const appointmentCountByClient = new Map<string, number>();
  for (const appointment of appointments) {
    if (!appointment.clientId) continue;
    appointmentCountByClient.set(appointment.clientId, (appointmentCountByClient.get(appointment.clientId) ?? 0) + 1);
  }
  const clientsWithAppointments = appointmentCountByClient.size;
  if (clientsWithAppointments === 0) {
    return 0;
  }
  const returningClients = [...appointmentCountByClient.values()].filter((count) => count > 1).length;
  return Math.round((returningClients / clientsWithAppointments) * 1000) / 10;
}

const SLOT_GRANULARITY_MINUTES = 30;
const WEEKDAYS_BY_JS_DAY: readonly Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function timeframeToDays(timeframe: AnalyticsTimeframe): number | null {
  if (timeframe === "7d") return 7;
  if (timeframe === "30d") return 30;
  return null; // 'all'
}

function isoDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function minutesBetween(hours: { start: string; end: string }): number {
  const [startHour = 0, startMinute = 0] = hours.start.split(":").map(Number);
  const [endHour = 0, endMinute = 0] = hours.end.split(":").map(Number);
  return endHour * 60 + endMinute - (startHour * 60 + startMinute);
}

/** Potential appointment slots per day-of-week, from the tenant's configured working hours. */
function potentialSlotsPerWeekday(workingHours: WorkingHours): Record<Weekday, number> {
  const result = {} as Record<Weekday, number>;
  for (const weekday of WEEKDAYS_BY_JS_DAY) {
    const hours = workingHours[weekday];
    result[weekday] = hours ? Math.max(0, Math.floor(minutesBetween(hours) / SLOT_GRANULARITY_MINUTES)) : 0;
  }
  return result;
}

function estimatePotentialSlots(workingHours: WorkingHours, days: number): number {
  const perWeekday = potentialSlotsPerWeekday(workingHours);
  let total = 0;
  const today = new Date();
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - offset);
    const weekday = WEEKDAYS_BY_JS_DAY[date.getUTCDay()];
    total += weekday ? perWeekday[weekday] : 0;
  }
  return total;
}

/**
 * [weekday 0=Sun..6=Sat][hour 0-23] booking counts, in the tenant's own
 * timezone (not UTC — "peak hours" is only useful to staff read against
 * their own clock). Built from appointments already fetched for the
 * retention calculation above, so this is free of extra queries.
 */
function buildBookingHeatmap(appointments: { startTime: string }[], timezone: string): number[][] {
  const heatmap: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", weekday: "short", hour: "2-digit" });
  const weekdayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  for (const appointment of appointments) {
    const parts = formatter.formatToParts(new Date(appointment.startTime));
    const weekdayPart = parts.find((part) => part.type === "weekday")?.value;
    const hourPart = parts.find((part) => part.type === "hour")?.value;
    const dayIndex = weekdayPart ? weekdayIndex[weekdayPart] : undefined;
    const hour = hourPart ? Number(hourPart) % 24 : undefined;
    if (dayIndex === undefined || hour === undefined || Number.isNaN(hour)) {
      continue;
    }
    const row = heatmap[dayIndex];
    if (row) {
      row[hour] = (row[hour] ?? 0) + 1;
    }
  }

  return heatmap;
}

export async function getTenantDashboardMetrics(tenantId: string, timeframe: AnalyticsTimeframe): Promise<TenantDashboardMetrics> {
  const days = timeframeToDays(timeframe);
  const sinceIso = days !== null ? isoDateDaysAgo(days) : undefined;

  const [tenant, dailyStats, toneDistribution, bookingsByChannel, confirmedAppointments] = await Promise.all([
    getTenantById(tenantId),
    getTenantDailyStats(tenantId, sinceIso),
    getToneDistribution(tenantId),
    countAppointmentsByChannel(tenantId, sinceIso ? { fromIso: `${sinceIso}T00:00:00.000Z` } : {}),
    listAppointments(tenantId, { status: "confirmed", ...(sinceIso ? { fromIso: `${sinceIso}T00:00:00.000Z` } : {}) }),
  ]);

  if (!tenant) {
    throw new Error(`Unknown tenant: ${tenantId}`);
  }

  const totalAppointments = dailyStats.reduce((sum, day) => sum + day.totalAppointments, 0);
  const cancelledAppointments = dailyStats.reduce((sum, day) => sum + day.cancelledAppointments, 0);
  const cancellationRatePct = totalAppointments > 0 ? Math.round((cancelledAppointments / totalAppointments) * 1000) / 10 : 0;

  const aiBookings = (bookingsByChannel.ai_chat ?? 0) + (bookingsByChannel.ai_voice ?? 0);
  const totalChannelBookings = aiBookings + (bookingsByChannel.staff_manual ?? 0);
  const aiAgentEfficiencyPct = totalChannelBookings > 0 ? Math.round((aiBookings / totalChannelBookings) * 1000) / 10 : 0;

  const clientRetentionRatePct = computeClientRetentionRatePct(confirmedAppointments);

  const potentialSlots = estimatePotentialSlots(tenant.workingHours, days ?? 90);
  const slotUtilizationRatePct = potentialSlots > 0 ? Math.min(100, Math.round((totalAppointments / potentialSlots) * 1000) / 10) : 0;

  const bookingHeatmap = buildBookingHeatmap(confirmedAppointments, tenant.timezone);

  return {
    timeframe,
    dailyStats,
    toneDistribution,
    totalAppointments,
    cancellationRatePct,
    slotUtilizationRatePct,
    clientRetentionRatePct,
    aiAgentEfficiencyPct,
    bookingsByChannel,
    bookingHeatmap,
  };
}
