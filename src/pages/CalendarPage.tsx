/**
 * /admin/calendar — dedicated booking-management view. Currently the
 * same real, filterable, search-capable table AppointmentsCalendarView
 * has always been (search/filter bar, status filter — Step 1.2.3's
 * requirements 2-3). A full interactive month/week/day/agenda calendar
 * grid (Step 1.2.3 requirement 1 — click-empty-slot-to-book,
 * click-booking-for-a-details-drawer) is real additional UI-engineering
 * scope beyond what this pass covers, not something to fake with a
 * non-functional calendar widget.
 */
import { AppointmentsCalendarView } from "../components/Dashboard.js";
import { useAuth } from "../context/AuthContext.js";
import { useDashboardData } from "../hooks/useDashboardData.js";

export default function CalendarPage(): JSX.Element {
  const { tenantId } = useAuth();
  const data = useDashboardData(tenantId ?? "");

  return <AppointmentsCalendarView data={data} />;
}
