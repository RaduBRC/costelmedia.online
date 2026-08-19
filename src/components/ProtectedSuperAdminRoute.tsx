/**
 * Gates /super-admin/* — same shape as ProtectedTenantRoute.tsx, plus the
 * extra isSuperAdmin check: a signed-in tenant_admin (or staff) must be
 * bounced to their own dashboard, not the login screen, since they *are*
 * authenticated, just not authorized for this. Client-side only, same as
 * every other route guard in this app — the real enforcement is
 * requireSuperAdmin on the backend (src/api/middleware/auth.ts); this is
 * just what keeps a regular tenant user from seeing the page at all.
 */
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";

export default function ProtectedSuperAdminRoute(): JSX.Element {
  const { session, isSuperAdmin, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-violet-600 border-t-transparent" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!isSuperAdmin) {
    return <Navigate to="/admin/dashboard" replace />;
  }

  return <Outlet />;
}
