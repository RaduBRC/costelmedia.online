/**
 * Single dispatcher: given a client (`userId` = client_profiles.id), an
 * appointment, and a target platform, resolves that client's stored push
 * registration and sends the correctly-shaped sticky reminder.
 */
import { getCalendarEventLocation } from "../calendar/googleCalendarEngine.js";
import { getAppointmentByIdUnscoped, getPushSubscription, getTenantById } from "../db/supabase.js";
import type { PushPlatform } from "../db/supabase.js";
import { sendAndroidOngoingNotification } from "./androidPush.js";
import { sendIosLiveActivityUpdate } from "./iosPush.js";
import { buildAndroidOngoingNotification, buildIOSLiveActivityPayload } from "./stickyPayloads.js";
import { buildWebPushPayload, sendWebPushNotification } from "./webPush.js";
import type { WebPushSubscription } from "./webPush.js";

export type NotificationPlatform = PushPlatform;

function isAndroidTarget(value: Record<string, unknown>): value is { token: string } {
  return typeof value["token"] === "string";
}

function isIosTarget(value: Record<string, unknown>): value is { deviceToken: string } {
  return typeof value["deviceToken"] === "string";
}

function isWebTarget(value: Record<string, unknown>): value is WebPushSubscription {
  const keys = value["keys"];
  return (
    typeof value["endpoint"] === "string" &&
    typeof keys === "object" &&
    keys !== null &&
    typeof (keys as Record<string, unknown>)["p256dh"] === "string" &&
    typeof (keys as Record<string, unknown>)["auth"] === "string"
  );
}

/**
 * Sends a sticky appointment reminder to `userId` (a client_profiles.id) on
 * the given platform. Looks up the appointment, the client's stored push
 * registration for that platform, and dispatches to the matching sender.
 */
export async function sendStickyReminder(
  userId: string,
  appointmentId: string,
  platform: NotificationPlatform,
): Promise<void> {
  const appointment = await getAppointmentByIdUnscoped(appointmentId);
  if (!appointment) {
    throw new Error(`No appointment found with id ${appointmentId}.`);
  }

  const rawTarget = await getPushSubscription(userId, platform);
  if (!rawTarget) {
    throw new Error(`No ${platform} push registration found for user ${userId}.`);
  }

  switch (platform) {
    case "android": {
      if (!isAndroidTarget(rawTarget)) {
        throw new Error(`Stored Android push target for user ${userId} is malformed.`);
      }
      const config = buildAndroidOngoingNotification(appointment);
      await sendAndroidOngoingNotification(rawTarget.token, config);
      return;
    }
    case "ios": {
      if (!isIosTarget(rawTarget)) {
        throw new Error(`Stored iOS push target for user ${userId} is malformed.`);
      }
      const tenant = await getTenantById(appointment.tenantId);
      if (!tenant) {
        throw new Error(`Unknown tenant ${appointment.tenantId} for appointment ${appointmentId}.`);
      }
      const locationAddress = appointment.googleEventId
        ? await getCalendarEventLocation(tenant.id, tenant.googleCalendarId, appointment.googleEventId)
        : "";
      const state = buildIOSLiveActivityPayload(appointment, tenant, locationAddress);
      await sendIosLiveActivityUpdate(rawTarget.deviceToken, state);
      return;
    }
    case "web": {
      if (!isWebTarget(rawTarget)) {
        throw new Error(`Stored web push subscription for user ${userId} is malformed.`);
      }
      const payload = buildWebPushPayload(appointment);
      await sendWebPushNotification(rawTarget, payload);
      return;
    }
  }
}
