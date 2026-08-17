/**
 * Top nav for the public marketing/legal surface (LandingPage, Privacy,
 * Terms) — via PublicLayout.tsx. Distinct from DashboardLayout's header:
 * that one shows tenant identity + system status for logged-in staff,
 * this one shows anchor links to the landing page's own sections plus a
 * Login/Dashboard CTA depending on whether a session already exists.
 */
import { useState } from "react";
import { Menu, Sparkles, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";

export default function PublicNav(): JSX.Element {
  const { session } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600 text-white">
            <Sparkles className="h-4.5 w-4.5" />
          </div>
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">CostelMedia</span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          <a href="/#features" className="text-sm font-medium text-slate-600 hover:text-violet-600 dark:text-slate-300 dark:hover:text-violet-400">
            Features
          </a>
          <a href="/#niches" className="text-sm font-medium text-slate-600 hover:text-violet-600 dark:text-slate-300 dark:hover:text-violet-400">
            Industries
          </a>
          <a href="/#pricing" className="text-sm font-medium text-slate-600 hover:text-violet-600 dark:text-slate-300 dark:hover:text-violet-400">
            Pricing
          </a>
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link
            to={session ? "/admin/dashboard" : "/login"}
            className="flex h-10 items-center rounded-lg bg-violet-600 px-4 text-sm font-medium text-white transition active:scale-95 hover:bg-violet-500"
          >
            {session ? "Go to Dashboard" : "Login"}
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setMenuOpen((current) => !current)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 active:bg-slate-100 md:hidden dark:text-slate-300 dark:active:bg-slate-800"
        >
          {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {menuOpen && (
        <nav className="flex flex-col gap-1 border-t border-slate-200 px-4 py-3 md:hidden dark:border-slate-800">
          <a
            href="/#features"
            onClick={() => setMenuOpen(false)}
            className="flex h-11 items-center text-sm font-medium text-slate-600 dark:text-slate-300"
          >
            Features
          </a>
          <a href="/#niches" onClick={() => setMenuOpen(false)} className="flex h-11 items-center text-sm font-medium text-slate-600 dark:text-slate-300">
            Industries
          </a>
          <a
            href="/#pricing"
            onClick={() => setMenuOpen(false)}
            className="flex h-11 items-center text-sm font-medium text-slate-600 dark:text-slate-300"
          >
            Pricing
          </a>
          <Link
            to={session ? "/admin/dashboard" : "/login"}
            onClick={() => setMenuOpen(false)}
            className="mt-2 flex h-11 items-center justify-center rounded-lg bg-violet-600 text-sm font-medium text-white"
          >
            {session ? "Go to Dashboard" : "Login"}
          </Link>
        </nav>
      )}
    </header>
  );
}
