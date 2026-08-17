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
import ProtectedTenantRoute from "./components/ProtectedTenantRoute.js";
import PublicLayout from "./components/PublicLayout.js";
import { ToastProvider } from "./components/Toast.js";
import { AuthProvider } from "./context/AuthContext.js";
import AnalyticsPage from "./pages/AnalyticsPage.js";
import CalendarPage from "./pages/CalendarPage.js";
import ClientsPage from "./pages/ClientsPage.js";
import ForgotPasswordPage from "./pages/ForgotPasswordPage.js";
import LandingPage from "./pages/LandingPage.js";
import OverviewPage from "./pages/OverviewPage.js";
import PrivacyPolicyPage from "./pages/PrivacyPolicyPage.js";
import ResetPasswordPage from "./pages/ResetPasswordPage.js";
import ServicesPage from "./pages/ServicesPage.js";
import SettingsPage from "./pages/SettingsPage.js";
import TermsOfServicePage from "./pages/TermsOfServicePage.js";
import ChatToolPage from "./pages/tools/ChatToolPage.js";
import VoiceToolPage from "./pages/tools/VoiceToolPage.js";
import WidgetToolPage from "./pages/tools/WidgetToolPage.js";

export default function App(): JSX.Element {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          <Route element={<PublicLayout />}>
            <Route path="/" element={<LandingPage />} />
            <Route path="/privacy" element={<PrivacyPolicyPage />} />
            <Route path="/terms" element={<TermsOfServicePage />} />
          </Route>

          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />

          <Route element={<ProtectedTenantRoute />}>
            <Route element={<DashboardLayout />}>
              <Route path="/admin/dashboard" element={<OverviewPage />} />
              <Route path="/admin/calendar" element={<CalendarPage />} />
              <Route path="/admin/clients" element={<ClientsPage />} />
              <Route path="/admin/analytics" element={<AnalyticsPage />} />
              <Route path="/admin/services" element={<ServicesPage />} />
              <Route path="/admin/settings" element={<SettingsPage />} />
              <Route path="/admin/tools/chat" element={<ChatToolPage />} />
              <Route path="/admin/tools/voice" element={<VoiceToolPage />} />
              <Route path="/admin/tools/widget" element={<WidgetToolPage />} />
            </Route>
          </Route>

          {/* Unknown paths land on the public homepage now, not the
              authenticated dashboard — standard marketing-site behavior,
              and correct for a logged-out visitor who mistyped a URL. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}
