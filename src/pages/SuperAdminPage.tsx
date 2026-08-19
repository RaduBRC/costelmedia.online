/**
 * /super-admin — every tenant on the platform, read-only. Deliberately
 * minimal: this is a real, working foundation (GET /api/super-admin/tenants,
 * requireSuperAdmin-gated end to end), not the full "god mode" panel a
 * platform admin panel could eventually be — deactivating a tenant,
 * impersonating a user, managing platform_admins from the UI, etc. are
 * real, separate features, not built here. See the conversation this
 * shipped in for that scoping decision.
 */
import { useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { getSuperAdminTenants } from "../lib/api.js";
import { useToast } from "../components/Toast.js";
import type { Tenant } from "../types/index.js";

export default function SuperAdminPage(): JSX.Element {
  const { showToast } = useToast();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getSuperAdminTenants()
      .then(setTenants)
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to load tenants.", "error");
      })
      .finally(() => setIsLoading(false));
    // showToast is stable (ToastProvider) — intentionally not re-fetching on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8 sm:px-6 dark:bg-slate-950">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600 text-white">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Super Admin</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">Every tenant on the platform — {tenants.length} total.</p>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400 dark:border-slate-800">
                <th className="px-4 py-2 font-medium">Business name</th>
                <th className="px-4 py-2 font-medium">Industry</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">Tenant ID</th>
              </tr>
            </thead>
            <tbody>
              {tenants.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                    {isLoading ? "Loading…" : "No tenants on the platform yet."}
                  </td>
                </tr>
              ) : (
                tenants.map((tenant) => (
                  <tr key={tenant.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2.5 text-slate-700 dark:text-slate-200">{tenant.name}</td>
                    <td className="px-4 py-2.5 capitalize text-slate-500 dark:text-slate-400">{tenant.businessType.replace("_", " ")}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          tenant.isActive
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                            : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                        }`}
                      >
                        {tenant.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{new Date(tenant.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-400 dark:text-slate-500">{tenant.id}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {isLoading && (
          <div className="mt-6 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
          </div>
        )}
      </div>
    </div>
  );
}
