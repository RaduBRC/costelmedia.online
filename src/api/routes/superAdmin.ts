/**
 * Platform-wide management routes — /api/super-admin/*. Every route here
 * is gated by requireSuperAdmin, not requireTenantAuth: a super admin
 * isn't scoped to any tenant, so there's no :tenantId to check against.
 * Read-only across the board except the plan PATCH — tenants list, VIP
 * leads, cross-tenant knowledge gaps, voice-pipeline system health
 * (latency/failure visibility), platform-wide usage, and plan changes.
 * Still deliberately scoped out: deactivating/impersonating a tenant,
 * editing platform_admins from the UI, etc. — see the conversation this
 * shipped in.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import {
  getUsageSummary,
  listAllKnowledgeGaps,
  listAllServiceFailures,
  listAllTenants,
  listAllVipLeads,
  listAllVoiceCallMetrics,
  updateTenantPlan,
} from "../../db/supabase.js";
import type { TenantPlan } from "../../types/index.js";
import { requireSuperAdmin } from "../middleware/auth.js";

export const superAdminRouter: express.Router = express.Router();

const VALID_PLANS: readonly TenantPlan[] = ["starter", "vip"];

function isTenantPlan(value: unknown): value is TenantPlan {
  return typeof value === "string" && (VALID_PLANS as readonly string[]).includes(value);
}

superAdminRouter.get("/tenants", requireSuperAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const tenants = await listAllTenants();
    res.json(tenants);
  } catch (error) {
    next(error);
  }
});

/**
 * Every "Request VIP Integration" lead across every tenant — how a super
 * admin actually discovers there's a lead to work, since there's no
 * automated notification (email/Slack/CRM webhook) wired up for this yet.
 */
superAdminRouter.get("/vip-leads", requireSuperAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const leads = await listAllVipLeads();
    res.json(leads);
  } catch (error) {
    next(error);
  }
});

interface UpdatePlanBody {
  plan?: string;
}

/**
 * The one and only way a tenant moves to VIP — no self-serve upgrade
 * button anywhere in the tenant-facing app. A super admin calls this
 * manually after working a vip_leads entry (or any other manual sales
 * conversation) to completion. See 022_onboarding_plans_and_leads.sql.
 */
superAdminRouter.patch(
  "/tenants/:tenantId/plan",
  requireSuperAdmin,
  async (req: Request<{ tenantId: string }, unknown, UpdatePlanBody>, res: Response, next: NextFunction) => {
    try {
      if (!isTenantPlan(req.body.plan)) {
        res.status(400).json({ error: `plan must be one of: ${VALID_PLANS.join(", ")}.` });
        return;
      }
      const tenant = await updateTenantPlan(req.params.tenantId, req.body.plan);
      res.json(tenant);
    } catch (error) {
      next(error);
    }
  },
);

/** Every knowledge gap across every tenant — the frontend groups these by businessType client-side (small dataset, no need for a server-side aggregation query) so a curator can spot patterns per vertical. */
superAdminRouter.get("/knowledge-gaps", requireSuperAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const gaps = await listAllKnowledgeGaps();
    res.json(gaps);
  } catch (error) {
    next(error);
  }
});

export interface SystemHealthSummary {
  totalTurns: number;
  whisperUsageRatePct: number;
  avgLlmLatencyMs: number | null;
  avgTtsFirstByteLatencyMs: number | null;
  avgTotalTurnLatencyMs: number | null;
  recentFailures: Awaited<ReturnType<typeof listAllServiceFailures>>;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * The "why is this call slow/broken" visibility this pipeline never had
 * before — aggregated from the last 1000 voice_call_metrics rows (recent
 * enough to reflect current behavior, capped so this stays a fast query
 * regardless of how long the platform's been running) plus the 500 most
 * recent service failures across every tenant.
 */
superAdminRouter.get("/system-health", requireSuperAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [metrics, recentFailures] = await Promise.all([listAllVoiceCallMetrics(1000), listAllServiceFailures(500)]);

    const summary: SystemHealthSummary = {
      totalTurns: metrics.length,
      whisperUsageRatePct: metrics.length === 0 ? 0 : Math.round((metrics.filter((m) => m.whisperUsed).length / metrics.length) * 100),
      avgLlmLatencyMs: average(metrics.map((m) => m.llmLatencyMs).filter((v): v is number => v !== null)),
      avgTtsFirstByteLatencyMs: average(metrics.map((m) => m.ttsFirstByteLatencyMs).filter((v): v is number => v !== null)),
      avgTotalTurnLatencyMs: average(metrics.map((m) => m.totalTurnLatencyMs).filter((v): v is number => v !== null)),
      recentFailures,
    };
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

/** Platform-wide usage over the last 30 days — the cost-visibility counterpart to a tenant's own GET /api/tenants/:tenantId/usage. */
superAdminRouter.get("/usage", requireSuperAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await getUsageSummary(null, 30);
    res.json(summary);
  } catch (error) {
    next(error);
  }
});
