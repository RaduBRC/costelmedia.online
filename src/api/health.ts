/**
 * GET /health — checks the three external dependencies the platform can't
 * function without: Groq (LLM), Supabase (data), and the Google service
 * account (calendar). Each check is independent and time-bounded, so one
 * slow/down dependency can't hang the whole endpoint.
 */
import express from "express";
import type { Request, Response } from "express";
import { CALENDAR_SCOPES } from "../calendar/googleCalendarEngine.js";
import { getGoogleAccessToken, loadGoogleServiceAccountCredentials } from "../auth/googleServiceAccount.js";
import { getSupabaseClient } from "../db/supabase.js";

export const healthRouter: express.Router = express.Router();

type CheckStatus = "ok" | "down" | "not_configured";

interface CheckResult {
  status: CheckStatus;
  detail?: string;
}

const CHECK_TIMEOUT_MS = 3000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)));
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function checkGroq(): Promise<CheckResult> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) {
    return { status: "not_configured", detail: "GROQ_API_KEY not set." };
  }
  try {
    const response = await withTimeout(
      fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } }),
      CHECK_TIMEOUT_MS,
      "Groq connectivity check",
    );
    if (!response.ok) {
      return { status: "down", detail: `Groq responded ${response.status}.` };
    }
    return { status: "ok" };
  } catch (error) {
    return { status: "down", detail: error instanceof Error ? error.message : "Unknown error." };
  }
}

async function checkSupabase(): Promise<CheckResult> {
  if (!process.env["SUPABASE_URL"] || !process.env["SUPABASE_SERVICE_ROLE_KEY"]) {
    return { status: "not_configured", detail: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set." };
  }
  try {
    const runQuery = async (): Promise<string | null> => {
      const { error } = await getSupabaseClient().from("tenants").select("id", { count: "exact", head: true }).limit(1);
      return error ? error.message : null;
    };
    const errorMessage = await withTimeout(runQuery(), CHECK_TIMEOUT_MS, "Supabase connectivity check");
    if (errorMessage) {
      return { status: "down", detail: errorMessage };
    }
    return { status: "ok" };
  } catch (error) {
    return { status: "down", detail: error instanceof Error ? error.message : "Unknown error." };
  }
}

async function checkGoogleCalendar(): Promise<CheckResult> {
  if (!process.env["GOOGLE_SERVICE_ACCOUNT_EMAIL"] || !process.env["GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"]) {
    return { status: "not_configured", detail: "Google service account credentials not set." };
  }
  try {
    const credentials = loadGoogleServiceAccountCredentials();
    await withTimeout(getGoogleAccessToken(credentials, CALENDAR_SCOPES), CHECK_TIMEOUT_MS, "Google Calendar token check");
    return { status: "ok" };
  } catch (error) {
    return { status: "down", detail: error instanceof Error ? error.message : "Unknown error." };
  }
}

function overallStatus(checks: CheckResult[]): "ok" | "degraded" | "down" {
  if (checks.some((check) => check.status === "down")) {
    return "down";
  }
  if (checks.some((check) => check.status === "not_configured")) {
    return "degraded";
  }
  return "ok";
}

// Lightweight liveness check for the deploy platform's health check.
// Deliberately does NOT call Groq/Supabase/Google — a transient
// third-party outage must never fail the deploy. See /health above
// for the full dependency status report.
healthRouter.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

healthRouter.get("/health", async (_req: Request, res: Response) => {
  const [groq, supabase, googleCalendar] = await Promise.all([checkGroq(), checkSupabase(), checkGoogleCalendar()]);
  const status = overallStatus([groq, supabase, googleCalendar]);

  res.status(status === "down" ? 503 : 200).json({
    status,
    checks: { groq, supabase, googleCalendar },
    timestamp: new Date().toISOString(),
  });
});
