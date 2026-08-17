/**
 * Global marketing/legal footer — shared by LandingPage, PrivacyPolicyPage,
 * and TermsOfServicePage via PublicLayout.tsx. Deliberately not rendered
 * inside DashboardLayout.tsx: the authenticated app already has its own
 * header/sidebar chrome, and a marketing footer with Privacy/Terms links
 * belongs on the public-facing surface, not repeated on every admin screen.
 */
import { Sparkles } from "lucide-react";
import { Link } from "react-router-dom";

const CONTACT_EMAIL = "contact@costelmedia.online";

export default function Footer(): JSX.Element {
  return (
    <footer className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="flex flex-col gap-8 sm:flex-row sm:justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-600 text-white">
                <Sparkles className="h-4 w-4" />
              </div>
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">CostelMedia</span>
            </div>
            <p className="max-w-xs text-xs text-slate-500 dark:text-slate-400">
              AI voice &amp; chat receptionist that books appointments for clinics, salons, auto shops, legal practices, and more.
            </p>
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-xs text-violet-600 hover:underline dark:text-violet-400">
              {CONTACT_EMAIL}
            </a>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:flex sm:gap-16">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Product</span>
              <a href="/#features" className="text-xs text-slate-600 hover:text-violet-600 dark:text-slate-300 dark:hover:text-violet-400">
                Features
              </a>
              <a href="/#pricing" className="text-xs text-slate-600 hover:text-violet-600 dark:text-slate-300 dark:hover:text-violet-400">
                Pricing
              </a>
              {/* Both kept as separate links (not just one that swaps
                  label based on session) — /admin/dashboard already
                  redirects to /login on its own if there's no session, so
                  showing both is never a dead end either way. */}
              <Link to="/login" className="text-xs text-slate-600 hover:text-violet-600 dark:text-slate-300 dark:hover:text-violet-400">
                Login
              </Link>
              <Link to="/admin/dashboard" className="text-xs text-slate-600 hover:text-violet-600 dark:text-slate-300 dark:hover:text-violet-400">
                Dashboard
              </Link>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Legal</span>
              <Link to="/privacy" className="text-xs text-slate-600 hover:text-violet-600 dark:text-slate-300 dark:hover:text-violet-400">
                Privacy Policy
              </Link>
              <Link to="/terms" className="text-xs text-slate-600 hover:text-violet-600 dark:text-slate-300 dark:hover:text-violet-400">
                Terms of Service
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-8 border-t border-slate-100 pt-6 dark:border-slate-800/60">
          <p className="text-[11px] text-slate-400 dark:text-slate-500">© {new Date().getFullYear()} CostelMedia. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
