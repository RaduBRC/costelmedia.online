/** Boots the Express API server, the voice WebSocket stream, and the reminder cron scheduler. */
// Must be the first import: every other module in this graph reads
// process.env.* (some at call time, but prodChecklist and the port
// constant below read it at module-evaluation time), so .env has to be
// loaded before anything downstream has a chance to see an unset
// variable. Previously this app relied on the operator remembering to
// `source .env` or pass `node --env-file=.env` themselves — that's how a
// real ELEVENLABS_API_KEY sitting right there in .env still read as
// "not set" the moment the server was started a different way. Silently
// a no-op if .env doesn't exist (e.g. production, where real env vars are
// injected by the host) — see dotenv's own default `override: false`
// behavior, which also means already-set env vars (a real deploy
// platform's injected secrets) always win over anything in .env.
import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { startReminderScheduler } from "../cron/reminderScheduler.js";
import { attachVoiceStreamServer } from "../telephony/voiceStreamServer.js";
import { runProductionChecklist } from "../utils/prodChecklist.js";
import { logElevenLabsConfigSanityCheck } from "../telephony/elevenLabsTts.js";

const port = Number(process.env["PORT"] ?? 8787);

async function main(): Promise<void> {
  logElevenLabsConfigSanityCheck();

  const checklist = await runProductionChecklist();
  for (const check of checklist.checks) {
    if (!check.passed) {
      const log = check.severity === "critical" ? console.error : console.warn;
      log(`[prodChecklist] ${check.severity.toUpperCase()} ${check.name} failed${check.detail ? `: ${check.detail}` : "."}`);
    }
  }
  if (!checklist.ok) {
    console.error("[prodChecklist] one or more critical checks failed.");
    if (process.env["NODE_ENV"] === "production") {
      process.exit(1);
    }
  }

  // A plain http.Server, not app.listen() directly — the voice WebSocket
  // stream (Twilio Media Streams) needs to hook the server's "upgrade"
  // event, which only exists on the underlying http.Server, not on the
  // Express app itself.
  const httpServer = createServer(createApp());
  attachVoiceStreamServer(httpServer);

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`AI booking platform API listening on http://localhost:${port}`);
  });

  // Opt out via CRON_ENABLED=false — useful for local dev against a shared
  // Supabase project where you don't want to be sending real reminders.
  if (process.env["CRON_ENABLED"] !== "false") {
    const task = startReminderScheduler();
    console.log("Reminder scheduler started (every 5 minutes).");

    const shutdown = (): void => {
      void task.stop();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }
}

main().catch((error: unknown) => {
  console.error("Fatal error during server startup:", error);
  process.exit(1);
});
