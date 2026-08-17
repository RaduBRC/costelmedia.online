/**
 * /admin/dashboard — the metrics + recent-appointments snapshot that used
 * to be the "calendar" tab's content in the pre-routing App.tsx. The new,
 * dedicated /admin/calendar (CalendarPage.tsx) is where the full
 * filterable appointments view lives now.
 *
 * The specific new metrics this route's spec asked for — bookings-today
 * %-change, AI call conversion rate, saved receptionist hours, revenue —
 * aren't built here: revenue needs the services catalog's price data
 * (just added — see ServicesPage.tsx — but not yet joined into
 * statsEngine.ts's aggregation), and "saved hours" has no agreed formula
 * yet. Shipping fabricated numbers for either would be worse than not
 * having them; MetricsBar below is exactly what's real today.
 */
import { MetricsBar, AppointmentsCalendarView } from "../components/Dashboard.js";
import { useAuth } from "../context/AuthContext.js";
import { useDashboardData } from "../hooks/useDashboardData.js";

export default function OverviewPage(): JSX.Element {
  const { tenantId } = useAuth();
  const data = useDashboardData(tenantId ?? "");

  return (
    <div className="space-y-6">
      <MetricsBar metrics={data.metrics} />
      <AppointmentsCalendarView data={data} />
    </div>
  );
}
