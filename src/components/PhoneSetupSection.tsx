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
import type { FormEvent } from "react";
import { AlertTriangle, Loader2, Phone, PhoneForwarded, Search, ShoppingCart, X } from "lucide-react";
import { getAvailableTwilioNumbers, getPhoneConfig, provisionTwilioNumber } from "../lib/api.js";
import type { AvailableTwilioNumber, PhoneConfig } from "../lib/api.js";
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

/**
 * Self-service number search + purchase — only shown when the tenant has
 * no number yet (see the parent's branch below): buying a second number
 * while one's already active is a bigger, separate feature (what happens
 * to the old one?) not built here on purpose.
 */
function NumberProvisioningPanel({ tenantId, onProvisioned }: { tenantId: string; onProvisioned: (phoneNumber: string) => void }): JSX.Element {
  const { showToast } = useToast();
  const [areaCode, setAreaCode] = useState("");
  const [results, setResults] = useState<AvailableTwilioNumber[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [confirmingNumber, setConfirmingNumber] = useState<AvailableTwilioNumber | null>(null);
  const [isProvisioning, setIsProvisioning] = useState(false);

  const handleSearch = (event: FormEvent): void => {
    event.preventDefault();
    setIsSearching(true);
    getAvailableTwilioNumbers(tenantId, areaCode.trim() || undefined)
      .then((numbers) => {
        setResults(numbers);
        setHasSearched(true);
      })
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Failed to search for numbers.", "error"))
      .finally(() => setIsSearching(false));
  };

  const handleConfirmPurchase = (): void => {
    if (!confirmingNumber) return;
    setIsProvisioning(true);
    provisionTwilioNumber(tenantId, confirmingNumber.phoneNumber)
      .then((result) => {
        showToast(`${result.phoneNumber} is now your AI agent's number.`, "success");
        onProvisioned(result.phoneNumber);
        setConfirmingNumber(null);
      })
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Failed to purchase this number.", "error"))
      .finally(() => setIsProvisioning(false));
  };

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Get a number for your AI agent</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Search for an available number and buy it directly — it's ready to receive calls immediately. This is a real phone number with
          a real monthly charge from Twilio, billed to this account.
        </p>
      </div>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={areaCode}
          onChange={(event) => setAreaCode(event.target.value)}
          placeholder="Area code (optional, e.g. 415)"
          className="min-h-11 flex-1 rounded-lg border border-slate-300 bg-transparent px-3 text-sm outline-none focus:border-violet-500 dark:border-slate-700"
        />
        <button
          type="submit"
          disabled={isSearching}
          className="flex min-h-11 items-center gap-1.5 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white transition active:scale-[0.98] disabled:opacity-60"
        >
          {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Search
        </button>
      </form>

      {hasSearched && (
        <div className="space-y-2">
          {results.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-3 text-center text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              No numbers found for that area code — try a different one or leave it blank.
            </p>
          ) : (
            results.map((number) => (
              <div
                key={number.phoneNumber}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-800"
              >
                <div>
                  <p className="font-mono text-sm text-slate-800 dark:text-slate-100">{number.phoneNumber}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {[number.locality, number.region].filter(Boolean).join(", ") || "—"} · {number.monthlyPriceHint}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmingNumber(number)}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-violet-300 px-3 text-xs font-medium text-violet-700 transition hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/40"
                >
                  <ShoppingCart className="h-3.5 w-3.5" />
                  Buy
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {confirmingNumber && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 flex items-start justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-50">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Confirm purchase
              </h3>
              <button type="button" onClick={() => setConfirmingNumber(null)} aria-label="Close" className="text-slate-400 hover:text-slate-600">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-1 font-mono text-lg text-slate-900 dark:text-slate-50">{confirmingNumber.phoneNumber}</p>
            <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
              This purchases a real phone number and starts billing ({confirmingNumber.monthlyPriceHint}) immediately. This can't be
              undone from this dashboard.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmingNumber(null)}
                className="min-h-11 flex-1 rounded-lg border border-slate-300 text-sm font-medium text-slate-600 dark:border-slate-700 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmPurchase}
                disabled={isProvisioning}
                className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-violet-600 text-sm font-medium text-white transition disabled:opacity-60"
              >
                {isProvisioning && <Loader2 className="h-4 w-4 animate-spin" />}
                Confirm & buy
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
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
      <div className="space-y-6">
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
          <p className="font-medium text-slate-700 dark:text-slate-200">No virtual entry number assigned yet.</p>
          <p className="mt-1 text-xs">Search for one below, or contact support if you'd rather have one set up for you.</p>
        </section>
        <NumberProvisioningPanel tenantId={tenantId} onProvisioned={(phoneNumber) => setConfig({ twilioPhoneNumber: phoneNumber, whatsappEnabled: false })} />
      </div>
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
