/**
 * /api/tenants/:tenantId/services — CRUD for the tenant's service
 * catalog (supabase/migrations/015_services_catalog.sql). Reads are open
 * to any tenant member; writes/deletes follow the same staff-vs-admin
 * split the rest of the dashboard uses (deletion is destructive/
 * irreversible-ish, so it's tenant_admin-only — see requireTenantAdmin).
 *
 * "Any updates made here must invoke the backend API so the AI prompt
 * updates instantly for the next call" (the original spec) is satisfied
 * structurally, not by any extra plumbing here: buildActiveServicesList
 * (src/agent/promptBuilder.ts) queries services fresh on every single
 * turn via processClientMessage — there's no cache to invalidate, so a
 * write through this route is already live for the very next message.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { deleteService, insertService, listServices, updateService } from "../../db/supabase.js";
import { requireTenantAdmin, requireTenantAuth } from "../middleware/auth.js";

export const servicesRouter: express.Router = express.Router({ mergeParams: true });

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const VALID_CURRENCIES = ["RON", "EUR"];

interface ServiceInput {
  name?: string;
  durationMinutes?: number;
  priceMinorUnits?: number;
  currency?: string;
  description?: string | null;
  isActive?: boolean;
}

function validateServiceInput(body: ServiceInput, requireAllFields: boolean): string | null {
  if (requireAllFields || body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > MAX_NAME_LENGTH) {
      return `name is required and must be ${MAX_NAME_LENGTH} characters or fewer.`;
    }
  }
  if (requireAllFields || body.durationMinutes !== undefined) {
    if (typeof body.durationMinutes !== "number" || !Number.isInteger(body.durationMinutes) || body.durationMinutes <= 0) {
      return "durationMinutes must be a positive integer.";
    }
  }
  if (requireAllFields || body.priceMinorUnits !== undefined) {
    if (typeof body.priceMinorUnits !== "number" || !Number.isInteger(body.priceMinorUnits) || body.priceMinorUnits < 0) {
      return "priceMinorUnits must be a non-negative integer (minor units — e.g. bani/cents).";
    }
  }
  if (body.currency !== undefined && !VALID_CURRENCIES.includes(body.currency)) {
    return `currency must be one of: ${VALID_CURRENCIES.join(", ")}.`;
  }
  if (body.description !== undefined && body.description !== null && body.description.length > MAX_DESCRIPTION_LENGTH) {
    return `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`;
  }
  return null;
}

servicesRouter.get("/", requireTenantAuth, async (req: Request<{ tenantId: string }>, res: Response, next: NextFunction) => {
  try {
    const services = await listServices(req.params.tenantId);
    res.json(services);
  } catch (error) {
    next(error);
  }
});

servicesRouter.post(
  "/",
  requireTenantAuth,
  async (req: Request<{ tenantId: string }, unknown, ServiceInput>, res: Response, next: NextFunction) => {
    try {
      const validationError = validateServiceInput(req.body, true);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
      // Validated above — narrow the optional-in-the-type fields to their
      // guaranteed-present shape for insertService's stricter input type.
      const { name, durationMinutes, priceMinorUnits, currency, description, isActive } = req.body;
      const service = await insertService({
        tenantId: req.params.tenantId,
        name: name as string,
        durationMinutes: durationMinutes as number,
        priceMinorUnits: priceMinorUnits as number,
        ...(currency ? { currency: currency as "RON" | "EUR" } : {}),
        description: description ?? null,
        ...(isActive !== undefined ? { isActive } : {}),
      });
      res.status(201).json(service);
    } catch (error) {
      next(error);
    }
  },
);

servicesRouter.patch(
  "/:serviceId",
  requireTenantAuth,
  async (req: Request<{ tenantId: string; serviceId: string }, unknown, ServiceInput>, res: Response, next: NextFunction) => {
    try {
      const validationError = validateServiceInput(req.body, false);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
      const { name, durationMinutes, priceMinorUnits, currency, description, isActive } = req.body;
      const service = await updateService(req.params.tenantId, req.params.serviceId, {
        ...(name !== undefined ? { name } : {}),
        ...(durationMinutes !== undefined ? { durationMinutes } : {}),
        ...(priceMinorUnits !== undefined ? { priceMinorUnits } : {}),
        ...(currency !== undefined ? { currency: currency as "RON" | "EUR" } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      });
      res.json(service);
    } catch (error) {
      next(error);
    }
  },
);

servicesRouter.delete(
  "/:serviceId",
  requireTenantAuth,
  requireTenantAdmin,
  async (req: Request<{ tenantId: string; serviceId: string }>, res: Response, next: NextFunction) => {
    try {
      await deleteService(req.params.tenantId, req.params.serviceId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);
