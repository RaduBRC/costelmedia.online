/**
 * "Website Widget" tab: shows each tenant their own ready-to-paste embed
 * snippet for the standalone chat widget (public/widget.js, served by
 * src/api/routes/widget.ts — see DEPLOYMENT.md §7). `tenantId` here is the
 * account's real, session-derived tenant, so there's nothing to configure
 * beyond copying the snippet onto the business's own website.
 */
import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { API_BASE_URL } from "../lib/api.js";
import { useToast } from "./Toast.js";

// The widget script is served from the same backend origin the dashboard
// itself talks to (API_BASE_URL, or the current origin for same-origin
// deployments) — never hardcoded, so this panel is correct in every
// environment (local dev, staging, production) without edits.
const WIDGET_SCRIPT_ORIGIN = API_BASE_URL || window.location.origin;

function buildSnippet(tenantId: string): string {
  return `<script src="${WIDGET_SCRIPT_ORIGIN}/widget.js" data-tenant-id="${tenantId}" async></script>`;
}

export default function WidgetEmbedPanel({ tenantId }: { tenantId: string }): JSX.Element {
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const snippet = buildSnippet(tenantId);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      showToast("Embed code copied to clipboard.", "success");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast("Couldn't copy automatically — select the code and copy it manually.", "error");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Website widget</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Paste this snippet onto your website, right before the closing <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800">&lt;/body&gt;</code> tag.
          A chat bubble will appear in the corner of every page it's on, ready to answer questions and book
          appointments with the same AI agent used in the Live Chat Simulator.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Embed code</h3>
          <button
            type="button"
            onClick={() => {
              void handleCopy();
            }}
            className="flex min-h-12 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-600 transition active:scale-95 active:bg-slate-100 sm:min-h-0 sm:px-2.5 sm:py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:active:bg-slate-800 dark:hover:bg-slate-800"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="overflow-x-auto px-4 py-4 text-xs text-slate-700 dark:text-slate-200">
          <code>{snippet}</code>
        </pre>
      </div>

      <div className="rounded-xl border border-dashed border-slate-300 p-4 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
        <p className="font-medium text-slate-600 dark:text-slate-300">A few things worth knowing:</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-4">
          <li>
            The tenant id in this snippet identifies your business only — like a publishable key, it's safe to
            have visible in your page's source, and on its own it can't access anything beyond chatting with
            your own AI agent.
          </li>
          <li>
            Visitors are asked for a phone number the first time they chat (needed to book a real appointment);
            returning visitors on the same browser aren't asked again.
          </li>
          <li>
            The <code className="rounded bg-slate-100 px-1 py-0.5 dark:bg-slate-800">async</code> attribute is required — it keeps the widget from ever slowing down your page's
            load.
          </li>
        </ul>
        <a
          href={`${WIDGET_SCRIPT_ORIGIN}/widget.js`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1 font-medium text-violet-700 hover:underline dark:text-violet-400"
        >
          View the raw widget script <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}
