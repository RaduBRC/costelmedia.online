/**
 * Gates every /admin/* route behind a real session: shows a spinner
 * during the initial check, redirects to /login (preserving the
 * originally-requested URL in state, so login can send them back) when
 * unauthenticated, and renders the route tree otherwise.
 */
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";

export default function ProtectedTenantRoute(): JSX.Element {
  const { session, isLoading } = useAuth();
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

  return <Outlet />;
}
