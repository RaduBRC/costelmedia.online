/**
 * "Phone Setup" tab (SettingsPage.tsx): shows the tenant's assigned
 * virtual entry number (GET /api/tenants/:tenantId/phone) and the GSM
 * call-forwarding codes a client dials from THEIR OWN business phone to
 * route calls to it.
 *
 * These are standard GSM/3GPP MMI call-forwarding codes (star-six-one,
 * star-six-two, star-six-seven, star-two-one), not something invented per
 * carrier — they work identically on Vodafone,
 * Orange, Digi, and effectively every GSM network, because call
 * forwarding is a network-standard feature, not a carrier-specific one.
 * Presented that way rather than fabricating different codes per carrier,
 * which would just be wrong and could leave someone's forwarding broken.
 */
import { useEffect, useState } from "react";
import { Loader2, Phone, PhoneForwarded } from "lucide-react";
import { getPhoneConfig } from "../lib/api.js";
import type { PhoneConfig } from "../lib/api.js";
import { useToast } from "./Toast.js";

interface UssdCode {
  scenario: string;
  description: string;
  activate: string;
  deactivate: string;
}

function buildUssdCodes(rawNumber: string): UssdCode[] {
  const dialNumber = rawNumber.replace(/[^\d+]/g, "");
  return [
    {
      scenario: "Forward missed calls (no answer)",
      description: "Routes a call to your AI agent only if it rings on your phone without being picked up — the most common setup.",
      activate: `**61*${dialNumber}#`,
      deactivate: "##61#",
    },
    {
      scenario: "Forward when busy",
      description: "Routes a call to your AI agent if you're already on another call.",
      activate: `**67*${dialNumber}#`,
      deactivate: "##67#",
    },
    {
      scenario: "Forward when unreachable",
      description: "Routes a call to your AI agent when your phone is off or out of signal.",
      activate: `**62*${dialNumber}#`,
      deactivate: "##62#",
    },
    {
      scenario: "Forward ALL calls (unconditional)",
      description: "Every call goes straight to your AI agent, even if you're available — use this only if you want the AI to always answer first.",
      activate: `**21*${dialNumber}#`,
      deactivate: "##21#",
    },
  ];
}

export default function PhoneSetupSection({ tenantId }: { tenantId: string }): JSX.Element {
  const { showToast } = useToast();
  const [config, setConfig] = useState<PhoneConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getPhoneConfig(tenantId)
      .then(setConfig)
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Failed to load phone configuration.", "error"))
      .finally(() => setIsLoading(false));
  }, [tenantId, showToast]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!config?.twilioPhoneNumber) {
    return (
      <section className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
        <p className="font-medium text-slate-700 dark:text-slate-200">No virtual entry number assigned yet.</p>
        <p className="mt-1 text-xs">Contact support to have a dedicated number provisioned for your AI agent to answer on.</p>
      </section>
    );
  }

  const codes = buildUssdCodes(config.twilioPhoneNumber);

  return (
    <div className="space-y-6">
      <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
            <Phone className="h-4.5 w-4.5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Your AI agent's number</h2>
            <p className="font-mono text-lg text-slate-900 dark:text-slate-50">{config.twilioPhoneNumber}</p>
          </div>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          This is the number your AI agent answers on. Forward calls from your own business line to this number using one of the setups
          below — dial the code from the phone you want to forward FROM.
        </p>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center gap-2">
          <PhoneForwarded className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Call forwarding codes</h2>
        </div>
        <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
          Standard GSM forwarding codes — these work the same way on Vodafone, Orange, Digi, and virtually every other GSM carrier,
          since call forwarding is a network standard, not something specific to one provider.
        </p>
        <div className="space-y-3">
          {codes.map((code) => (
            <div key={code.scenario} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{code.scenario}</p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{code.description}</p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  Activate: {code.activate}
                </span>
                <span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  Cancel: {code.deactivate}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
