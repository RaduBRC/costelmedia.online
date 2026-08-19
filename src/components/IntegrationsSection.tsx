/**
 * "Integrations" tab (SettingsPage.tsx): shows the tenant's current plan
 * and, for Starter, a locked feature list with a "Request VIP
 * Integration" button that opens VipLeadModal.tsx. There's no self-serve
 * upgrade button anywhere here on purpose — see 022_onboarding_plans_and_leads.sql
 * and superAdmin.ts's PATCH /tenants/:tenantId/plan for why moving to VIP
 * is always a human, manual action.
 */
import { useState } from "react";
import { Check, Crown, Lock } from "lucide-react";
import VipLeadModal from "./VipLeadModal.js";
import type { TenantPlan } from "../types/index.js";

const VIP_FEATURES = [
  "Custom CRM integration",
  "ERP / inventory system sync",
  "WhatsApp Business sync",
  "Unlimited Google Calendar connections",
  "Custom-cloned brand voice",
  "Fully custom AI instructions (beyond the default template)",
];

export default function IntegrationsSection({ tenantId, plan }: { tenantId: string; plan: TenantPlan }): JSX.Element {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Current plan</h2>
          <span
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
              plan === "vip"
                ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            }`}
          >
            {plan === "vip" && <Crown className="h-3.5 w-3.5" />}
            {plan === "vip" ? "VIP" : "Starter"}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {plan === "vip"
            ? "Your account has full access to custom integrations and advanced AI configuration."
            : "The Starter plan includes one Google Calendar connection, standard voice options, and the default AI prompt template for your industry."}
        </p>
      </section>

      {plan === "starter" && (
        <section className="rounded-xl border border-violet-200 bg-violet-50 p-5 dark:border-violet-900 dark:bg-violet-950/30">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-violet-900 dark:text-violet-200">
            <Lock className="h-4 w-4" />
            VIP-only integrations
          </h2>
          <ul className="mt-3 space-y-1.5">
            {VIP_FEATURES.map((feature) => (
              <li key={feature} className="flex items-center gap-2 text-sm text-violet-800 dark:text-violet-300">
                <Lock className="h-3.5 w-3.5 shrink-0 opacity-60" />
                {feature}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="mt-4 flex min-h-11 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white transition active:scale-[0.98] hover:bg-violet-500"
          >
            <Crown className="h-4 w-4" />
            Request VIP Integration
          </button>
        </section>
      )}

      {plan === "vip" && (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 dark:border-emerald-900 dark:bg-emerald-950/30">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-emerald-900 dark:text-emerald-200">
            <Check className="h-4 w-4" />
            All VIP features unlocked
          </h2>
          <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-300">
            Custom integrations (CRM, ERP, WhatsApp sync, cloned voice) are set up directly by our team — reach out to your account
            contact for changes.
          </p>
        </section>
      )}

      {modalOpen && <VipLeadModal tenantId={tenantId} onClose={() => setModalOpen(false)} />}
    </div>
  );
}
