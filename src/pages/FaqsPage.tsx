/**
 * /admin/faqs — real CRUD against the tenant_faqs table
 * (019_tenant_tone_and_faqs.sql), mirroring ServicesPage.tsx's exact
 * pattern. Every write goes through the backend API (src/api/routes/faqs.ts),
 * which is what makes edits here "instant" for the AI: processClientMessage
 * queries FAQs fresh every turn (see promptBuilder.ts's formatFaqs), same
 * as services — nothing cached in between.
 */
import { useCallback, useEffect, useState } from "react";
import { HelpCircle, Loader2, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { createFaq, deleteFaq, getKnowledgeGaps, listFaqs, patchFaq } from "../lib/api.js";
import type { FaqInput } from "../lib/api.js";
import { useToast } from "../components/Toast.js";
import { useAuth } from "../context/AuthContext.js";
import type { Faq, KnowledgeGap } from "../types/index.js";

const EMPTY_FORM: FaqInput = { question: "", answer: "", displayOrder: 0, isActive: true };

function FaqFormModal({
  initial,
  onCancel,
  onSubmit,
  isSaving,
}: {
  initial: FaqInput;
  onCancel: () => void;
  onSubmit: (input: FaqInput) => void;
  isSaving: boolean;
}): JSX.Element {
  const [form, setForm] = useState<FaqInput>(initial);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onCancel}>
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-6 shadow-xl sm:rounded-2xl dark:bg-slate-900"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold text-slate-900 dark:text-slate-50">{initial.question ? "Edit FAQ" : "Add new FAQ"}</h3>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(form);
          }}
        >
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Question
            <input
              required
              maxLength={300}
              value={form.question}
              onChange={(event) => setForm({ ...form, question: event.target.value })}
              className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700"
            />
          </label>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Answer
            <textarea
              required
              maxLength={2000}
              rows={4}
              value={form.answer}
              onChange={(event) => setForm({ ...form, answer: event.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              The AI quotes this exactly when a client asks something matching this question — see promptBuilder.ts's formatFaqs.
            </span>
          </label>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Display order
            <input
              type="number"
              value={form.displayOrder ?? 0}
              onChange={(event) => setForm({ ...form, displayOrder: Number(event.target.value) })}
              className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700"
            />
            <span className="mt-1 block text-[11px] text-slate-400">Lower numbers are listed first. Ties don't matter — the AI doesn't read this as ranking importance.</span>
          </label>
          <label className="flex min-h-11 items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={form.isActive ?? true}
              onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500 dark:border-slate-700"
            />
            Active (available to the AI)
          </label>
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="min-h-12 flex-1 rounded-lg border border-slate-300 text-sm font-medium text-slate-600 transition active:scale-[0.98] dark:border-slate-700 dark:text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-lg bg-violet-600 text-sm font-medium text-white transition active:scale-[0.98] disabled:opacity-60"
            >
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function FaqsPage(): JSX.Element {
  const { tenantId, role } = useAuth();
  const { showToast } = useToast();
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState<Faq | "new" | null>(null);
  const [draftQuestion, setDraftQuestion] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const refresh = useCallback(() => {
    if (!tenantId) return;
    setIsLoading(true);
    listFaqs(tenantId)
      .then(setFaqs)
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to load FAQs.", "error");
      })
      .finally(() => setIsLoading(false));
    // Best-effort, separate from the main load state — a failure here
    // shouldn't block the FAQ list itself from showing.
    getKnowledgeGaps(tenantId)
      .then(setGaps)
      .catch(() => {
        /* Suggested-FAQs panel just stays empty — not worth a toast. */
      });
  }, [tenantId, showToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAddFromGap = (question: string): void => {
    setDraftQuestion(question);
    setEditing("new");
  };

  const handleSubmit = (input: FaqInput): void => {
    if (!tenantId) return;
    setIsSaving(true);
    const request = editing === "new" ? createFaq(tenantId, input) : patchFaq(tenantId, (editing as Faq).id, input);
    request
      .then(() => {
        showToast(editing === "new" ? "FAQ added." : "FAQ updated.", "success");
        setEditing(null);
        setDraftQuestion("");
        refresh();
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to save FAQ.", "error");
      })
      .finally(() => setIsSaving(false));
  };

  const handleToggleActive = (faq: Faq): void => {
    if (!tenantId) return;
    patchFaq(tenantId, faq.id, { isActive: !faq.isActive })
      .then(() => {
        showToast(faq.isActive ? "FAQ disabled." : "FAQ enabled.", "success");
        refresh();
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to update FAQ.", "error");
      });
  };

  const handleDelete = (faq: Faq): void => {
    if (!tenantId) return;
    if (!window.confirm(`Delete "${faq.question}"? This can't be undone.`)) return;
    deleteFaq(tenantId, faq.id)
      .then(() => {
        showToast("FAQ deleted.", "success");
        refresh();
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to delete FAQ.", "error");
      });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Frequently Asked Questions</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Changes here take effect on the AI's very next reply — nothing to publish.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setDraftQuestion("");
            setEditing("new");
          }}
          className="flex h-11 items-center gap-1.5 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white transition active:scale-95"
        >
          <Plus className="h-4 w-4" />
          Add FAQ
        </button>
      </div>

      {gaps.length > 0 && (
        <section className="rounded-xl border border-violet-200 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950/30">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-violet-900 dark:text-violet-200">
            <Sparkles className="h-4 w-4" />
            Suggested FAQs from real questions
          </h3>
          <p className="mb-3 text-xs text-violet-800 dark:text-violet-300">
            These are real questions callers/chatters asked that neither your FAQs nor the general knowledge base covered — a good sign
            it's worth adding a real answer.
          </p>
          <ul className="space-y-2">
            {gaps.slice(0, 10).map((gap) => (
              <li
                key={gap.id}
                className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 text-sm text-slate-700 shadow-sm dark:bg-slate-900 dark:text-slate-200"
              >
                <span className="flex items-center gap-2">
                  <HelpCircle className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                  {gap.question}
                </span>
                <button
                  type="button"
                  onClick={() => handleAddFromGap(gap.question)}
                  className="shrink-0 rounded-lg border border-violet-300 px-2.5 py-1 text-xs font-medium text-violet-700 transition hover:bg-violet-100 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/60"
                >
                  Add as FAQ
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400 dark:border-slate-800">
              <th className="px-4 py-2 font-medium">Question</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {faqs.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                  {isLoading ? "Loading…" : "No FAQs yet — add the questions clients ask most often."}
                </td>
              </tr>
            ) : (
              faqs.map((faq) => (
                <tr key={faq.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                  <td className="max-w-md px-4 py-2.5 text-slate-700 dark:text-slate-200">
                    <span className="line-clamp-1">{faq.question}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => handleToggleActive(faq)}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium transition ${
                        faq.isActive
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                          : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                      }`}
                    >
                      {faq.isActive ? "Active" : "Inactive"}
                    </button>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEditing(faq)}
                        aria-label={`Edit ${faq.question}`}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition active:bg-slate-100 dark:text-slate-400 dark:active:bg-slate-800"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      {role === "tenant_admin" && (
                        <button
                          type="button"
                          onClick={() => handleDelete(faq)}
                          aria-label={`Delete ${faq.question}`}
                          className="flex h-9 w-9 items-center justify-center rounded-lg text-red-500 transition active:bg-red-50 dark:active:bg-red-950/40"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <FaqFormModal
          initial={
            editing === "new"
              ? { ...EMPTY_FORM, question: draftQuestion }
              : { question: editing.question, answer: editing.answer, displayOrder: editing.displayOrder, isActive: editing.isActive }
          }
          onCancel={() => {
            setEditing(null);
            setDraftQuestion("");
          }}
          onSubmit={handleSubmit}
          isSaving={isSaving}
        />
      )}
    </div>
  );
}
