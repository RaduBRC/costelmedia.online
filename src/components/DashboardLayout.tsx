/**
 * Persistent app shell for every /admin/* route: collapsible sidebar +
 * header bar, with the routed page rendered via <Outlet/>. Mounted once
 * by the /admin/* route tree in App.tsx, not per-page — navigating
 * between pages doesn't remount the sidebar/header.
 */
import { useEffect, useState } from "react";
import {
  BarChart3,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Code2,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Phone,
  Settings as SettingsIcon,
  Sparkles,
  Users,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import SystemStatusBadge from "./SystemStatusBadge.js";
import { useAuth } from "../context/AuthContext.js";
import { useDashboardData } from "../hooks/useDashboardData.js";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const BUSINESS_NAV: NavItem[] = [
  { to: "/admin/dashboard", label: "Overview", icon: LayoutDashboard },
  { to: "/admin/calendar", label: "Calendar & Bookings", icon: CalendarDays },
  { to: "/admin/clients", label: "Client Intelligence", icon: Users },
  { to: "/admin/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/admin/services", label: "Service Catalog", icon: Wrench },
  { to: "/admin/settings", label: "Settings", icon: SettingsIcon },
];

const TOOLS_NAV: NavItem[] = [
  { to: "/admin/tools/chat", label: "Live Chat Simulator", icon: MessageSquare },
  { to: "/admin/tools/voice", label: "Voice Call Simulator", icon: Phone },
  { to: "/admin/tools/widget", label: "Website Widget", icon: Code2 },
];

const SIDEBAR_COLLAPSED_KEY = "aibp-sidebar-collapsed";

function NavSection({ items, collapsed, onNavigate }: { items: NavItem[]; collapsed: boolean; onNavigate: () => void }): JSX.Element {
  return (
    <div className="space-y-0.5">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex h-12 items-center gap-3 rounded-lg px-3 text-sm font-medium transition active:scale-[0.98] ${
                isActive
                  ? "bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300"
                  : "text-slate-600 hover:bg-slate-100 active:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 dark:active:bg-slate-800"
              }`
            }
            title={collapsed ? item.label : undefined}
          >
            <Icon className="h-5 w-5 shrink-0" />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </NavLink>
        );
      })}
    </div>
  );
}

export default function DashboardLayout(): JSX.Element {
  const { user, tenantId, role, logout } = useAuth();
  const data = useDashboardData(tenantId ?? "");
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  const closeMobileNav = (): void => setMobileNavOpen(false);

  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Mobile nav backdrop */}
      {mobileNavOpen && <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={closeMobileNav} aria-hidden="true" />}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex flex-col border-r border-slate-200 bg-white transition-all dark:border-slate-800 dark:bg-slate-900 ${
          collapsed ? "w-[4.5rem]" : "w-64"
        } ${mobileNavOpen ? "translate-x-0" : "-translate-x-full"} md:sticky md:top-0 md:h-screen md:translate-x-0`}
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="flex h-16 shrink-0 items-center gap-2 border-b border-slate-200 px-4 dark:border-slate-800">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-white">
            <Sparkles className="h-4.5 w-4.5" />
          </div>
          {!collapsed && <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">AI Booking Platform</span>}
        </div>

        <nav className="flex-1 space-y-4 overflow-y-auto p-3">
          <NavSection items={BUSINESS_NAV} collapsed={collapsed} onNavigate={closeMobileNav} />
          <div>
            {!collapsed && <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Testing Tools</p>}
            <NavSection items={TOOLS_NAV} collapsed={collapsed} onNavigate={closeMobileNav} />
          </div>
        </nav>

        <button
          type="button"
          onClick={() => setCollapsed((current) => !current)}
          className="hidden h-12 items-center justify-center gap-2 border-t border-slate-200 text-xs font-medium text-slate-500 transition hover:bg-slate-100 md:flex dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          {!collapsed && "Collapse"}
        </button>
      </aside>

      <div className={`flex min-h-screen flex-1 flex-col transition-all ${collapsed ? "md:ml-0" : "md:ml-0"}`}>
        <header
          className="sticky top-0 z-30 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <div className="flex h-16 items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open navigation"
                className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 active:bg-slate-100 md:hidden dark:text-slate-400 dark:active:bg-slate-800"
              >
                <LayoutDashboard className="h-5 w-5" />
              </button>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">{data.tenant?.name ?? "Loading…"}</p>
                {role && <p className="truncate text-xs capitalize text-slate-500 dark:text-slate-400">{role.replace("_", " ")}</p>}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              <SystemStatusBadge />
              {user?.email && <span className="hidden text-xs text-slate-500 md:inline dark:text-slate-400">{user.email}</span>}
              <button
                type="button"
                onClick={() => {
                  void logout();
                }}
                aria-label="Sign out"
                className="flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-600 transition active:scale-95 active:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:active:bg-slate-800"
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-4 sm:px-6 sm:py-6" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
          {!tenantId ? (
            <p className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              Your account isn't linked to a tenant yet. Contact an administrator to be added to a tenant's staff.
            </p>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}
