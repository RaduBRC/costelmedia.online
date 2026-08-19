/**
 * "Request VIP Integration" lead-capture modal — SettingsPage.tsx's
 * Integrations tab. Submits to POST /api/tenants/:tenantId/vip-leads
 * (src/api/routes/tenantSettings.ts), which just stores the lead; there's
 * no automated provisioning behind this button — a human follows up and,
 * if it closes, manually moves the tenant to the VIP plan (see
 * superAdmin.ts). Framed accordingly: this promises a follow-up, not an
 * instant unlock.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import { Loader2, Send, X } from "lucide-react";
import { submitVipLead } from "../lib/api.js";
import { useToast } from "./Toast.js";

const INTEGRATION_OPTIONS = ["Custom CRM", "ERP / inventory system", "WhatsApp Business sync", "Custom voice (cloned brand voice)", "Other"];

const inputClass =
  "mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-sm text-slate-900 outline-none focus:border-violet-500 dark:border-slate-700 dark:text-slate-100";

export default function VipLeadModal({ tenantId, onClose }: { tenantId: string; onClose: () => void }): JSX.Element {
  const { showToast } = useToast();
  const [selectedIntegrations, setSelectedIntegrations] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const toggleIntegration = (option: string): void => {
    setSelectedIntegrations((current) => (current.includes(option) ? current.filter((item) => item !== option) : [...current, option]));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setIsSubmitting(true);
    submitVipLead(tenantId, {
      requestedIntegrations: selectedIntegrations,
      message: message.trim() || null,
      contactEmail: contactEmail.trim() || null,
      contactPhone: contactPhone.trim() || null,
    })
      .then(() => setSubmitted(true))
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to send your request.", "error");
      })
      .finally(() => setIsSubmitting(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Request VIP Integration</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {submitted ? "We'll follow up shortly." : "Tell us what you need — our team reaches out to set it up manually."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {submitted ? (
          <div className="space-y-4">
            <p className="rounded-lg bg-emerald-50 px-3 py-3 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
              Thanks — your request has been recorded. A member of our team will reach out to discuss VIP onboarding.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="flex min-h-11 w-full items-center justify-center rounded-lg bg-violet-600 px-4 text-sm font-medium text-white transition active:scale-[0.98] hover:bg-violet-500"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <span className="block text-xs font-medium text-slate-600 dark:text-slate-300">What do you need?</span>
              <div className="mt-1.5 space-y-1.5">
                {INTEGRATION_OPTIONS.map((option) => (
                  <label key={option} className="flex min-h-9 items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                    <input
                      type="checkbox"
                      checked={selectedIntegrations.includes(option)}
                      onChange={() => toggleIntegration(option)}
                      className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500 dark:border-slate-700"
                    />
                    {option}
                  </label>
                ))}
              </div>
            </div>

            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Anything else we should know?
              <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} className={inputClass} />
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                Contact email
                <input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} className={inputClass} />
              </label>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                Contact phone
                <input value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} className={inputClass} />
              </label>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white transition active:scale-[0.98] hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {isSubmitting ? "Sending…" : "Send request"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
