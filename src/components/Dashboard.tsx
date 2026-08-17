import { CalendarCheck, RefreshCw, TrendingUp, Users } from "lucide-react";
import { useDashboardData } from "../hooks/useDashboardData.js";
import type { DashboardData } from "../hooks/useDashboardData.js";
import { formatDateTime } from "../lib/format.js";
import type { TenantMetrics } from "../lib/api.js";
import type { AppointmentStatus } from "../types/index.js";

const STATUS_STYLES: Record<AppointmentStatus, string> = {
  confirmed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
  rescheduled: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
};

// ---------------------------------------------------------------------------
// Metrics bar
// ---------------------------------------------------------------------------

function StatCard({ icon: Icon, label, value, hint }: { icon: typeof Users; label: string; value: string; hint?: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-50">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{hint}</p>}
    </div>
  );
}

export function MetricsBar({ metrics }: { metrics: TenantMetrics | null }): JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard icon={CalendarCheck} label="Total appointments" value={metrics ? String(metrics.totalAppointments) : "—"} />
      <StatCard icon={CalendarCheck} label="Available slots today" value={metrics ? String(metrics.availableSlotsToday) : "—"} />
      <StatCard
        icon={TrendingUp}
        label="Client retention rate"
        value={metrics ? `${metrics.clientRetentionRate}%` : "—"}
        hint="Clients with 2+ confirmed visits"
      />
      <StatCard icon={Users} label="Total clients" value={metrics ? String(metrics.totalClients) : "—"} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appointments calendar / schedule table
// ---------------------------------------------------------------------------

export function AppointmentsCalendarView({ data }: { data: DashboardData }): JSX.Element {
  const { appointments, clientsById, statusFilter, setStatusFilter, dateFilter, setDateFilter, isLoading, refresh } = data;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Appointments</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={dateFilter}
            onChange={(event) => {
              setDateFilter(event.target.value);
            }}
            className="min-h-12 rounded-md border border-slate-300 bg-transparent px-2 text-base text-slate-700 sm:min-h-8 sm:text-xs dark:border-slate-700 dark:text-slate-200"
          />
          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as AppointmentStatus | "all");
            }}
            className="min-h-12 rounded-md border border-slate-300 bg-transparent px-2 text-base text-slate-700 sm:min-h-8 sm:text-xs dark:border-slate-700 dark:text-slate-200"
          >
            <option value="all">All statuses</option>
            <option value="confirmed">Confirmed</option>
            <option value="cancelled">Cancelled</option>
            <option value="rescheduled">Rescheduled</option>
          </select>
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
            aria-label="Refresh appointments"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-slate-300 text-slate-600 transition active:scale-95 active:bg-slate-100 sm:h-8 sm:w-8 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:active:bg-slate-800 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-4 w-4 sm:h-3.5 sm:w-3.5 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400 dark:border-slate-800">
              <th className="px-4 py-2 font-medium">Client</th>
              <th className="px-4 py-2 font-medium">Service</th>
              <th className="px-4 py-2 font-medium">Start</th>
              <th className="px-4 py-2 font-medium">End</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {appointments.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                  {isLoading ? "Loading…" : "No appointments match these filters."}
                </td>
              </tr>
            ) : (
              appointments.map((appointment) => (
                <tr key={appointment.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2.5 text-slate-700 dark:text-slate-200">
                    {(appointment.clientId && clientsById.get(appointment.clientId)?.fullName) || "Unknown"}
                  </td>
                  <td className="px-4 py-2.5 text-slate-700 dark:text-slate-200">{appointment.serviceType}</td>
                  <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{formatDateTime(appointment.startTime)}</td>
                  <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{formatDateTime(appointment.endTime)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[appointment.status]}`}>
                      {appointment.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Client insights panel
// ---------------------------------------------------------------------------

export function ClientInsightsPanel({ data }: { data: DashboardData }): JSX.Element {
  const { clients, appointmentCountByClient, isLoading } = data;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Client intelligence</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400 dark:border-slate-800">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Phone</th>
              <th className="px-4 py-2 font-medium">Formality</th>
              <th className="px-4 py-2 font-medium">Style</th>
              <th className="px-4 py-2 font-medium">Notes</th>
              <th className="px-4 py-2 font-medium">Visits</th>
            </tr>
          </thead>
          <tbody>
            {clients.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                  {isLoading ? "Loading…" : "No clients yet."}
                </td>
              </tr>
            ) : (
              clients.map((client) => (
                <tr key={client.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2.5 text-slate-700 dark:text-slate-200">{client.fullName ?? "—"}</td>
                  <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{client.phoneNumber}</td>
                  <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{client.formalityScore}/5</td>
                  <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{client.communicationStyle || "—"}</td>
                  <td className="max-w-xs truncate px-4 py-2.5 text-slate-500 dark:text-slate-400" title={client.notes}>
                    {client.notes || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{appointmentCountByClient.get(client.id) ?? 0}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full combined dashboard (metrics + calendar + client insights)
// ---------------------------------------------------------------------------

export default function Dashboard({ tenantId }: { tenantId: string }): JSX.Element {
  const data = useDashboardData(tenantId);

  if (!tenantId.trim()) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        Enter a tenant id in the header to load its dashboard.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{data.tenant?.name ?? "Loading tenant…"}</h2>
        {data.tenant && (
          <p className="text-xs capitalize text-slate-500 dark:text-slate-400">
            {data.tenant.businessType} · {data.tenant.timezone}
          </p>
        )}
      </div>
      <MetricsBar metrics={data.metrics} />
      <AppointmentsCalendarView data={data} />
      <ClientInsightsPanel data={data} />
    </div>
  );
}
