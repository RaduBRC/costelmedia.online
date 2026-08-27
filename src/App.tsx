/**
 * Route tree for the whole app. Public auth routes (/login,
 * /forgot-password, /reset-password) render standalone; everything under
 * /admin/* is gated by <ProtectedTenantRoute/> and shares one persistent
 * <DashboardLayout/> shell (sidebar + header), with each page rendered
 * into its <Outlet/>.
 */
import { Navigate, Route, Routes } from "react-router-dom";
import DashboardLayout from "./components/DashboardLayout.js";
import Login from "./components/Login.js";
import ProtectedSuperAdminRoute from "./components/ProtectedSuperAdminRoute.js";
import ProtectedTenantRoute from "./components/ProtectedTenantRoute.js";
import PublicLayout from "./components/PublicLayout.js";
import { ToastProvider } from "./components/Toast.js";
import { AuthProvider } from "./context/AuthContext.js";
import AnalyticsPage from "./pages/AnalyticsPage.js";
import CalendarPage from "./pages/CalendarPage.js";
import CallLogsPage from "./pages/CallLogsPage.js";
import ClientsPage from "./pages/ClientsPage.js";
import FaqsPage from "./pages/FaqsPage.js";
import ForgotPasswordPage from "./pages/ForgotPasswordPage.js";
import LandingPage from "./pages/LandingPage.js";
import OnboardingPage from "./pages/OnboardingPage.js";
import OverviewPage from "./pages/OverviewPage.js";
import PrivacyPolicyPage from "./pages/PrivacyPolicyPage.js";
import RegisterPage from "./pages/RegisterPage.js";
import ResetPasswordPage from "./pages/ResetPasswordPage.js";
import ServicesPage from "./pages/ServicesPage.js";
import SettingsPage from "./pages/SettingsPage.js";
import SuperAdminPage from "./pages/SuperAdminPage.js";
import TermsOfServicePage from "./pages/TermsOfServicePage.js";
import ChatToolPage from "./pages/tools/ChatToolPage.js";
import VoiceToolPage from "./pages/tools/VoiceToolPage.js";
import WidgetToolPage from "./pages/tools/WidgetToolPage.js";

export default function App(): JSX.Element {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          {/* Not nested under <PublicLayout/> — the landing page commits to
              its own dark "audio-signal" visual world with its own nav and
              footer (see LandingPage.tsx's header comment), while
              /privacy and /terms keep the standard site chrome. */}
          <Route path="/" element={<LandingPage />} />
          <Route element={<PublicLayout />}>
            <Route path="/privacy" element={<PrivacyPolicyPage />} />
            <Route path="/terms" element={<TermsOfServicePage />} />
          </Route>

          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />

          {/* Needs a session but deliberately NOT nested under
              DashboardLayout — a user landing here (via loginWithGoogle)
              may not have a tenantId yet, and DashboardLayout's Outlet
              area assumes one exists (shows a dead-end "not linked to a
              tenant" message otherwise). OnboardingPage handles the
              has-a-tenant-already case itself by redirecting onward. */}
          <Route element={<ProtectedTenantRoute />}>
            <Route path="/onboarding" element={<OnboardingPage />} />
          </Route>

          <Route element={<ProtectedTenantRoute />}>
            <Route element={<DashboardLayout />}>
              <Route path="/admin/dashboard" element={<OverviewPage />} />
              <Route path="/admin/calendar" element={<CalendarPage />} />
              <Route path="/admin/calls" element={<CallLogsPage />} />
              <Route path="/admin/clients" element={<ClientsPage />} />
              <Route path="/admin/analytics" element={<AnalyticsPage />} />
              <Route path="/admin/services" element={<ServicesPage />} />
              <Route path="/admin/faqs" element={<FaqsPage />} />
              <Route path="/admin/settings" element={<SettingsPage />} />
              <Route path="/admin/tools/chat" element={<ChatToolPage />} />
              <Route path="/admin/tools/voice" element={<VoiceToolPage />} />
              <Route path="/admin/tools/widget" element={<WidgetToolPage />} />
            </Route>
          </Route>

          {/* Standalone, not nested under DashboardLayout — a platform-wide
              page conceptually sits outside any one tenant's dashboard
              shell (which shows tenant-scoped nav/identity that doesn't
              apply here). requireSuperAdmin on the backend is the real
              enforcement; ProtectedSuperAdminRoute just keeps a regular
              tenant user from seeing the page exists at all. */}
          <Route element={<ProtectedSuperAdminRoute />}>
            <Route path="/super-admin" element={<SuperAdminPage />} />
            <Route path="/admin/tenants" element={<SuperAdminPage />} />
          </Route>

          {/* Literal alias for the more commonly-typed /dashboard — the
              app's real route has always been /admin/dashboard (every nav
              link, redirect, and bookmark already points there). */}
          <Route path="/dashboard" element={<Navigate to="/admin/dashboard" replace />} />

          {/* Unknown paths land on the public homepage now, not the
              authenticated dashboard — standard marketing-site behavior,
              and correct for a logged-out visitor who mistyped a URL. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}
