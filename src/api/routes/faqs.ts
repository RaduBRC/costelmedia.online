/**
 * /api/tenants/:tenantId/faqs — CRUD for the tenant's FAQ list
 * (supabase/migrations/019_tenant_tone_and_faqs.sql). Same shape as
 * services.ts: reads open to any tenant member, writes/deletes split
 * staff-vs-admin (deletion is tenant_admin-only).
 *
 * Same "instant for the AI" property as services: promptBuilder.ts's
 * formatFaqs is fed a fresh listFaqs(tenantId, {activeOnly: true}) on
 * every single turn (see groqAgent.ts's processClientMessage) — nothing
 * cached, so a write through this route is already live for the very
 * next message.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { deleteFaq, insertFaq, listFaqs, updateFaq } from "../../db/supabase.js";
import { requireTenantAdmin, requireTenantAuth } from "../middleware/auth.js";

export const faqsRouter: express.Router = express.Router({ mergeParams: true });

const MAX_QUESTION_LENGTH = 300;
const MAX_ANSWER_LENGTH = 2000;

interface FaqInput {
  question?: string;
  answer?: string;
  displayOrder?: number;
  isActive?: boolean;
}

function validateFaqInput(body: FaqInput, requireAllFields: boolean): string | null {
  if (requireAllFields || body.question !== undefined) {
    if (typeof body.question !== "string" || !body.question.trim() || body.question.length > MAX_QUESTION_LENGTH) {
      return `question is required and must be ${MAX_QUESTION_LENGTH} characters or fewer.`;
    }
  }
  if (requireAllFields || body.answer !== undefined) {
    if (typeof body.answer !== "string" || !body.answer.trim() || body.answer.length > MAX_ANSWER_LENGTH) {
      return `answer is required and must be ${MAX_ANSWER_LENGTH} characters or fewer.`;
    }
  }
  if (body.displayOrder !== undefined && (typeof body.displayOrder !== "number" || !Number.isInteger(body.displayOrder))) {
    return "displayOrder must be an integer.";
  }
  return null;
}

faqsRouter.get("/", requireTenantAuth, async (req: Request<{ tenantId: string }>, res: Response, next: NextFunction) => {
  try {
    const faqs = await listFaqs(req.params.tenantId);
    res.json(faqs);
  } catch (error) {
    next(error);
  }
});

faqsRouter.post(
  "/",
  requireTenantAuth,
  async (req: Request<{ tenantId: string }, unknown, FaqInput>, res: Response, next: NextFunction) => {
    try {
      const validationError = validateFaqInput(req.body, true);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
      const { question, answer, displayOrder, isActive } = req.body;
      const faq = await insertFaq({
        tenantId: req.params.tenantId,
        question: question as string,
        answer: answer as string,
        ...(displayOrder !== undefined ? { displayOrder } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      });
      res.status(201).json(faq);
    } catch (error) {
      next(error);
    }
  },
);

faqsRouter.patch(
  "/:faqId",
  requireTenantAuth,
  async (req: Request<{ tenantId: string; faqId: string }, unknown, FaqInput>, res: Response, next: NextFunction) => {
    try {
      const validationError = validateFaqInput(req.body, false);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
      const { question, answer, displayOrder, isActive } = req.body;
      const faq = await updateFaq(req.params.tenantId, req.params.faqId, {
        ...(question !== undefined ? { question } : {}),
        ...(answer !== undefined ? { answer } : {}),
        ...(displayOrder !== undefined ? { displayOrder } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      });
      res.json(faq);
    } catch (error) {
      next(error);
    }
  },
);

faqsRouter.delete(
  "/:faqId",
  requireTenantAuth,
  requireTenantAdmin,
  async (req: Request<{ tenantId: string; faqId: string }>, res: Response, next: NextFunction) => {
    try {
      await deleteFaq(req.params.tenantId, req.params.faqId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);
