/**
 * Express wrapper around threatSentinel.ts's evaluateThreat(), for the
 * routes that take a free-text message reaching an LLM (chat over the
 * dashboard, the widget, Twilio SMS/WhatsApp, and the generic webhook).
 * Structured-data routes like manual booking (no free-text "prompt" at
 * all) don't use this — see rateLimiter.ts for the request-volume half of
 * this module, which does apply there.
 *
 * Fails open on an unexpected internal error: this module is
 * defense-in-depth layered in *front of* the existing, unmodified
 * chat/booking pipeline (which still has its own guardrails.ts
 * sanitization downstream) — a bug or outage in the sentinel itself must
 * never be able to take a legitimate booking or chat down with it.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { evaluateThreat, GENERIC_BLOCKED_REPLY } from "./threatSentinel.js";
import type { ThreatEvaluation } from "../types/index.js";
import type { SecurityChannel } from "../types/index.js";

export interface ThreatSentinelOptions {
  /** Static channel label, or a per-request resolver for routes that serve more than one surface (e.g. dashboard /chat now also carries the voice-simulator's "ai_voice" traffic). */
  channel: SecurityChannel | ((req: Request) => SecurityChannel);
  /** Body field holding the free-text prompt to evaluate. Defaults to "message". */
  messageField?: string;
  /** How to resolve the tenant this request is for, for security_logs.tenant_id. Defaults to req.params.tenantId, then req.body.tenantId. */
  resolveTenantId?: (req: Request) => string | null | undefined;
  /** Custom response when blocked — lets each route match its own normal response shape (JSON with extra fields, TwiML, etc.). Defaults to `res.json({ reply: GENERIC_BLOCKED_REPLY })`. */
  onBlocked?: (req: Request, res: Response, evaluation: ThreatEvaluation) => void;
}

function defaultResolveTenantId(req: Request): string | null {
  const paramTenantId = req.params["tenantId"];
  if (typeof paramTenantId === "string" && paramTenantId) return paramTenantId;
  const body = req.body as Record<string, unknown> | undefined;
  const bodyTenantId = body?.["tenantId"];
  return typeof bodyTenantId === "string" ? bodyTenantId : (req.tenantId ?? null);
}

function defaultOnBlocked(_req: Request, res: Response): void {
  res.status(200).json({ reply: GENERIC_BLOCKED_REPLY });
}

export function threatSentinel(options: ThreatSentinelOptions): RequestHandler {
  const messageField = options.messageField ?? "message";
  const resolveTenantId = options.resolveTenantId ?? defaultResolveTenantId;
  const onBlocked = options.onBlocked ?? defaultOnBlocked;

  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as Record<string, unknown> | undefined;
    const message = body?.[messageField];

    if (typeof message !== "string" || message.trim().length === 0) {
      // Nothing here to evaluate — the route's own validation (every
      // wired-up route already checks for a missing/empty message) is
      // what handles this case; the sentinel only has an opinion once
      // there's actual text to score.
      next();
      return;
    }

    const channel = typeof options.channel === "function" ? options.channel(req) : options.channel;

    evaluateThreat({
      message,
      ipAddress: req.ip ?? "unknown",
      tenantId: resolveTenantId(req) ?? null,
      channel,
    })
      .then((evaluation) => {
        if (evaluation.blocked) {
          console.warn(
            `Threat Sentinel blocked a ${channel} message from ${req.ip ?? "unknown"} ` +
              `(category=${evaluation.category}, score=${evaluation.score}).`,
          );
          onBlocked(req, res, evaluation);
          return;
        }
        next();
      })
      .catch((error: unknown) => {
        console.error("Threat Sentinel: evaluation pipeline failed; failing open.", error);
        next();
      });
  };
}
