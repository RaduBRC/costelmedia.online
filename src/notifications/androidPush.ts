/** Sends an ongoing (sticky) Android notification via FCM HTTP v1. */
import { getGoogleAccessToken, loadGoogleServiceAccountCredentials } from "../auth/googleServiceAccount.js";
import type { AndroidNotificationConfig } from "./stickyPayloads.js";

const FCM_SCOPES = ["https://www.googleapis.com/auth/firebase.messaging"] as const;

export async function sendAndroidOngoingNotification(deviceToken: string, config: AndroidNotificationConfig): Promise<void> {
  const projectId = process.env["FCM_PROJECT_ID"];
  if (!projectId) {
    throw new Error("Missing FCM_PROJECT_ID environment variable.");
  }

  const credentials = loadGoogleServiceAccountCredentials();
  const accessToken = await getGoogleAccessToken(credentials, FCM_SCOPES);

  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        android: {
          priority: "high",
          notification: {
            title: config.title,
            body: config.body,
            channel_id: config.channelId,
            // FCM's `sticky` flag is what the Android system maps to a
            // non-swipeable ongoing notification (FLAG_ONGOING_EVENT).
            sticky: config.persistent,
            notification_priority: "PRIORITY_HIGH",
            icon: config.smallIcon,
          },
          data: config.data,
        },
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`FCM send failed (${response.status}): ${errorBody}`);
  }
}
