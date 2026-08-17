/**
 * Scheduled appointment reminders (24h and 2h ahead) and post-appointment
 * feedback/tone-refinement requests. Runs every 5 minutes via node-cron —
 * a plain in-process timer, so this requires a long-running Node process
 * (fine for Render's free web service; wouldn't work as-is on a serverless
 * platform, which is exactly why the frontend, not this, is what targets
 * Vercel — see vercel.json).
 *
 * Concurrency safety against duplicate reminders has two layers:
 *   1. Within this process: node-cron's `noOverlap` option skips a tick if
 *      the previous one hasn't finished.
 *   2. Across processes (e.g. a rolling deploy briefly running two
 *      instances): the atomic claim-pattern UPDATE...RETURNING queries in
 *      src/db/supabase.ts (claimAppointmentsFor24hReminder etc.) — see the
 *      comment there for why that's sufficient without a separate
 *      advisory-lock round trip.
 */
import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { sendSMSMessage, sendWhatsAppMessage } from "../channels/twilioService.js";
import {
  claimAppointmentsFor24hReminder,
  claimAppointmentsFor2hReminder,
  claimAppointmentsForFeedback,
  getClientProfileByIdUnscoped,
  getTenantById,
  getTenantTwilioRouting,
} from "../db/supabase.js";
import { sendStickyReminder } from "../notifications/notificationController.js";
import type { NotificationPlatform } from "../notifications/notificationController.js";
import { aggregateClientFeedback } from "../agent/toneRefiner.js";
import type { Appointment } from "../types/index.js";

const REMINDER_WINDOW_MS = 5 * 60 * 1000;
const REMINDER_24H_OFFSET_MS = 24 * 60 * 60 * 1000;
const REMINDER_2H_OFFSET_MS = 2 * 60 * 60 * 1000;

const ALL_PUSH_PLATFORMS: readonly NotificationPlatform[] = ["android", "ios", "web"];

function computeFutureWindow(offsetMs: number, nowMs: number): { startIso: string; endIso: string } {
  const start = new Date(nowMs + offsetMs);
  const end = new Date(start.getTime() + REMINDER_WINDOW_MS);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/** Best-effort: tries every platform the client might have a device registered on, ignoring "not registered" misses. */
async function dispatchStickyReminders(clientId: string, appointmentId: string): Promise<void> {
  await Promise.all(
    ALL_PUSH_PLATFORMS.map(async (platform) => {
      try {
        await sendStickyReminder(clientId, appointmentId, platform);
      } catch (error) {
        // Most of these are "no push registration for this platform" —
        // the overwhelmingly common case, not an error worth logging loudly.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("No") || !message.includes("registration")) {
          console.error(`[reminderScheduler] Sticky push failed (${platform}) for appointment ${appointmentId}:`, error);
        }
      }
    }),
  );
}

async function sendTextMessage(tenantId: string, phoneNumber: string, body: string): Promise<void> {
  const routing = await getTenantTwilioRouting(tenantId);
  if (routing?.whatsappEnabled) {
    await sendWhatsAppMessage(phoneNumber, body, tenantId);
  } else {
    await sendSMSMessage(phoneNumber, body, tenantId);
  }
}

async function sendReminderForAppointment(appointment: Appointment, humanWindowLabel: string): Promise<void> {
  if (!appointment.clientId) {
    return;
  }

  const [tenant, client] = await Promise.all([
    getTenantById(appointment.tenantId),
    getClientProfileByIdUnscoped(appointment.clientId),
  ]);
  if (!tenant || !client) {
    console.error(`[reminderScheduler] Missing tenant or client for appointment ${appointment.id}; skipping reminder.`);
    return;
  }

  const message = `Reminder: Your ${appointment.serviceType} appointment at ${tenant.name} is in ${humanWindowLabel}.`;

  try {
    await sendTextMessage(tenant.id, client.phoneNumber, message);
  } catch (error) {
    console.error(`[reminderScheduler] Failed to send text reminder for appointment ${appointment.id}:`, error);
  }

  await dispatchStickyReminders(client.id, appointment.id);
}

async function process24hReminders(nowMs: number): Promise<number> {
  const { startIso, endIso } = computeFutureWindow(REMINDER_24H_OFFSET_MS, nowMs);
  const claimed = await claimAppointmentsFor24hReminder(startIso, endIso);
  await Promise.all(claimed.map((appointment) => sendReminderForAppointment(appointment, "24 hours")));
  return claimed.length;
}

async function process2hReminders(nowMs: number): Promise<number> {
  const { startIso, endIso } = computeFutureWindow(REMINDER_2H_OFFSET_MS, nowMs);
  const claimed = await claimAppointmentsFor2hReminder(startIso, endIso);
  await Promise.all(claimed.map((appointment) => sendReminderForAppointment(appointment, "2 hours")));
  return claimed.length;
}

export interface ReminderCycleResult {
  reminders24hSent: number;
  reminders2hSent: number;
}

/**
 * Finds appointments starting in ~24h or ~2h that haven't been reminded
 * yet, sends a sticky push + WhatsApp/SMS message for each, and marks them
 * sent. Safe to call concurrently (see the module-level concurrency notes).
 */
export async function processUpcomingReminders(now: Date = new Date()): Promise<ReminderCycleResult> {
  const nowMs = now.getTime();
  const [reminders24hSent, reminders2hSent] = await Promise.all([process24hReminders(nowMs), process2hReminders(nowMs)]);
  return { reminders24hSent, reminders2hSent };
}

async function sendFeedbackRequest(appointment: Appointment): Promise<void> {
  if (!appointment.clientId) {
    return;
  }

  const [tenant, client] = await Promise.all([
    getTenantById(appointment.tenantId),
    getClientProfileByIdUnscoped(appointment.clientId),
  ]);
  if (!tenant || !client) {
    console.error(`[reminderScheduler] Missing tenant or client for completed appointment ${appointment.id}; skipping feedback request.`);
    return;
  }

  const message = `Thanks for visiting ${tenant.name}! How was your ${appointment.serviceType} appointment? Reply and let us know.`;

  try {
    await sendTextMessage(tenant.id, client.phoneNumber, message);
  } catch (error) {
    console.error(`[reminderScheduler] Failed to send feedback request for appointment ${appointment.id}:`, error);
  }

  try {
    await aggregateClientFeedback(client.id);
  } catch (error) {
    console.error(`[reminderScheduler] Tone refinement failed for client ${client.id}:`, error);
  }
}

/** Finds appointments that just ended (within the last 5 minutes), requests feedback, and refines the client's tone profile. */
export async function processPostAppointmentFeedback(now: Date = new Date()): Promise<number> {
  const nowMs = now.getTime();
  const windowEnd = new Date(nowMs).toISOString();
  const windowStart = new Date(nowMs - REMINDER_WINDOW_MS).toISOString();

  const claimed = await claimAppointmentsForFeedback(windowStart, windowEnd);
  await Promise.all(claimed.map((appointment) => sendFeedbackRequest(appointment)));
  return claimed.length;
}

async function runSchedulerCycle(): Promise<void> {
  try {
    const reminders = await processUpcomingReminders();
    const feedbackRequestsSent = await processPostAppointmentFeedback();
    console.log(
      `[reminderScheduler] cycle complete — 24h reminders: ${reminders.reminders24hSent}, ` +
        `2h reminders: ${reminders.reminders2hSent}, feedback requests: ${feedbackRequestsSent}`,
    );
  } catch (error) {
    console.error("[reminderScheduler] cycle failed:", error);
  }
}

/**
 * Starts the every-5-minutes scheduler. `noOverlap: true` makes node-cron
 * itself skip a tick if the previous one is still running, instead of
 * piling up concurrent executions if a run ever takes longer than 5
 * minutes.
 */
export function startReminderScheduler(): ScheduledTask {
  return cron.schedule("*/5 * * * *", runSchedulerCycle, { noOverlap: true, name: "reminder-scheduler" });
}
