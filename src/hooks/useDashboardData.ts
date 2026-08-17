/**
 * Shared dashboard data hook — one poller feeds every dashboard view, so
 * switching tabs never triggers a duplicate fetch cycle against the same
 * tenant. Also diffs each poll against the last to surface real-time
 * booking events as toasts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMetrics, getTenant, listAppointments, listClients } from "../lib/api.js";
import type { TenantMetrics } from "../lib/api.js";
import { formatDateTime } from "../lib/format.js";
import { useToast } from "../components/Toast.js";
import type { Appointment, AppointmentStatus, ClientProfile, Tenant } from "../types/index.js";

const POLL_INTERVAL_MS = 15000;

export interface DashboardData {
  tenant: Tenant | null;
  metrics: TenantMetrics | null;
  appointments: Appointment[];
  clients: ClientProfile[];
  clientsById: Map<string, ClientProfile>;
  appointmentCountByClient: Map<string, number>;
  statusFilter: AppointmentStatus | "all";
  setStatusFilter: (status: AppointmentStatus | "all") => void;
  dateFilter: string;
  setDateFilter: (date: string) => void;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useDashboardData(tenantId: string): DashboardData {
  const { showToast } = useToast();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [metrics, setMetrics] = useState<TenantMetrics | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [clients, setClients] = useState<ClientProfile[]>([]);
  const [statusFilter, setStatusFilter] = useState<AppointmentStatus | "all">("all");
  const [dateFilter, setDateFilter] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const previousStatusById = useRef<Map<string, AppointmentStatus> | null>(null);

  const refresh = useCallback(async () => {
    if (!tenantId.trim()) {
      return;
    }
    setIsLoading(true);
    try {
      const filters = {
        ...(statusFilter !== "all" ? { status: statusFilter } : {}),
        ...(dateFilter ? { from: `${dateFilter}T00:00:00.000Z`, to: `${dateFilter}T23:59:59.999Z` } : {}),
      };
      const [tenantResult, metricsResult, appointmentsResult, clientsResult] = await Promise.all([
        getTenant(tenantId),
        getMetrics(tenantId),
        listAppointments(tenantId, filters),
        listClients(tenantId),
      ]);
      setTenant(tenantResult);
      setMetrics(metricsResult);
      setAppointments(appointmentsResult);
      setClients(clientsResult);

      // Diff against the previous poll to surface real-time booking events —
      // skip the very first load so mounting the dashboard doesn't toast
      // every appointment that already existed.
      const previous = previousStatusById.current;
      if (previous) {
        for (const appointment of appointmentsResult) {
          const previousStatus = previous.get(appointment.id);
          if (!previousStatus) {
            showToast(`New ${appointment.status} booking: ${appointment.serviceType} on ${formatDateTime(appointment.startTime)}`, "success");
          } else if (previousStatus !== appointment.status) {
            showToast(`Appointment ${appointment.status}: ${appointment.serviceType} on ${formatDateTime(appointment.startTime)}`, "info");
          }
        }
      }
      previousStatusById.current = new Map(appointmentsResult.map((appointment) => [appointment.id, appointment.status]));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Failed to load dashboard data.", "error");
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, statusFilter, dateFilter, showToast]);

  useEffect(() => {
    // A new `refresh` identity means the tenant or filters changed — treat
    // the next fetch as a fresh baseline rather than diffing against a
    // previous tenant/filter's data (which would toast spurious "new
    // booking" events for appointments that simply weren't visible before).
    previousStatusById.current = null;
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
    };
  }, [refresh]);

  const clientsById = useMemo(() => new Map(clients.map((client) => [client.id, client])), [clients]);
  const appointmentCountByClient = useMemo(() => {
    const counts = new Map<string, number>();
    for (const appointment of appointments) {
      if (!appointment.clientId) continue;
      counts.set(appointment.clientId, (counts.get(appointment.clientId) ?? 0) + 1);
    }
    return counts;
  }, [appointments]);

  return {
    tenant,
    metrics,
    appointments,
    clients,
    clientsById,
    appointmentCountByClient,
    statusFilter,
    setStatusFilter,
    dateFilter,
    setDateFilter,
    isLoading,
    refresh,
  };
}
