/**
 * Web Push (PWA) notification payload + sender. The payload shape here is
 * exactly what `public/sw.js`'s `push` event handler expects to receive and
 * pass to `registration.showNotification(title, options)`.
 */
import webpush from "web-push";
import type { Appointment } from "../types/index.js";

// `type`, not `interface` — this needs to satisfy `Record<string, unknown>`
// structurally (see notificationController's type guard), which only
// object-literal type aliases get an implicit index signature for.
export type WebPushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export interface WebPushAction {
  action: "confirm" | "reschedule" | "directions";
  title: string;
}

export interface WebPushNotificationPayload {
  title: string;
  body: string;
  icon: string;
  badge: string;
  tag: string;
  renotify: boolean;
  requireInteraction: boolean;
  actions: WebPushAction[];
  data: { tenantId: string; appointmentId: string; status: Appointment["status"] };
}

const STANDARD_ACTIONS: WebPushAction[] = [
  { action: "confirm", title: "Confirm" },
  { action: "reschedule", title: "Reschedule" },
  { action: "directions", title: "Directions" },
];

function copyFor(appointment: Appointment): { title: string; body: string } {
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
      return { title: "Upcoming appointment", body: `${appointment.serviceType} — ${when}. Tap to manage.` };
  }
}

export function buildWebPushPayload(appointment: Appointment): WebPushNotificationPayload {
  const { title, body } = copyFor(appointment);
  return {
    title,
    body,
    icon: "/icons/appointment-192.png",
    badge: "/icons/badge-72.png",
    tag: `appointment-${appointment.id}`,
    renotify: true,
    requireInteraction: true,
    actions: STANDARD_ACTIONS,
    data: { tenantId: appointment.tenantId, appointmentId: appointment.id, status: appointment.status },
  };
}

let vapidConfigured = false;

function ensureVapidConfigured(): void {
  if (vapidConfigured) {
    return;
  }
  const publicKey = process.env["WEB_PUSH_VAPID_PUBLIC_KEY"];
  const privateKey = process.env["WEB_PUSH_VAPID_PRIVATE_KEY"];
  const contactEmail = process.env["WEB_PUSH_CONTACT_EMAIL"];

  if (!publicKey || !privateKey || !contactEmail) {
    throw new Error(
      "Missing WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY, or WEB_PUSH_CONTACT_EMAIL environment variables.",
    );
  }
  webpush.setVapidDetails(contactEmail, publicKey, privateKey);
  vapidConfigured = true;
}

/** Sends an encrypted Web Push message (RFC 8291, via the `web-push` library) to a subscribed browser. */
export async function sendWebPushNotification(
  subscription: WebPushSubscription,
  payload: WebPushNotificationPayload,
): Promise<void> {
  ensureVapidConfigured();
  await webpush.sendNotification(subscription, JSON.stringify(payload));
}
