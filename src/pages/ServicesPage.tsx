/**
 * /admin/services — real CRUD against the services table
 * (015_services_catalog.sql). Every write goes through the backend API
 * (src/api/routes/services.ts), which is what makes edits here "instant"
 * for the AI: processClientMessage queries services fresh every turn,
 * nothing cached in between.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { createService, deleteService, listServices, patchService } from "../lib/api.js";
import type { ServiceInput } from "../lib/api.js";
import { useToast } from "../components/Toast.js";
import { useAuth } from "../context/AuthContext.js";
import type { Currency, Service } from "../types/index.js";

function formatPrice(minorUnits: number, currency: Currency): string {
  return `${(minorUnits / 100).toFixed(2)} ${currency}`;
}

const EMPTY_FORM: ServiceInput = { name: "", durationMinutes: 30, priceMinorUnits: 0, currency: "RON", description: "", isActive: true };

function ServiceFormModal({
  initial,
  onCancel,
  onSubmit,
  isSaving,
}: {
  initial: ServiceInput;
  onCancel: () => void;
  onSubmit: (input: ServiceInput) => void;
  isSaving: boolean;
}): JSX.Element {
  const [form, setForm] = useState<ServiceInput>(initial);
  const [priceDisplay, setPriceDisplay] = useState((initial.priceMinorUnits / 100).toFixed(2));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onCancel}>
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-6 shadow-xl sm:rounded-2xl dark:bg-slate-900"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold text-slate-900 dark:text-slate-50">{initial.name ? "Edit service" : "Add new service"}</h3>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(form);
          }}
        >
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Service name
            <input
              required
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Duration (min)
              <input
                required
                type="number"
                min={1}
                value={form.durationMinutes}
                onChange={(event) => setForm({ ...form, durationMinutes: Number(event.target.value) })}
                className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700"
              />
            </label>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Price
              <div className="mt-1 flex gap-1">
                <input
                  required
                  type="number"
                  min={0}
                  step="0.01"
                  value={priceDisplay}
                  onChange={(event) => {
                    setPriceDisplay(event.target.value);
                    const parsed = Math.round(Number(event.target.value) * 100);
                    setForm({ ...form, priceMinorUnits: Number.isFinite(parsed) ? parsed : 0 });
                  }}
                  className="min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700"
                />
                <select
                  value={form.currency}
                  onChange={(event) => setForm({ ...form, currency: event.target.value as Currency })}
                  className="min-h-12 rounded-lg border border-slate-300 bg-transparent px-2 text-sm outline-none focus:border-violet-500 dark:border-slate-700"
                >
                  <option value="RON">RON</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>
            </label>
          </div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Description (optional)
            <textarea
              value={form.description ?? ""}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              rows={2}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700"
            />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500 dark:border-slate-700"
            />
            Active (bookable / offered to the AI)
          </label>
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="min-h-12 flex-1 rounded-lg border border-slate-300 text-sm font-medium text-slate-600 transition active:scale-[0.98] dark:border-slate-700 dark:text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-lg bg-violet-600 text-sm font-medium text-white transition active:scale-[0.98] disabled:opacity-60"
            >
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function ServicesPage(): JSX.Element {
  const { tenantId, role } = useAuth();
  const { showToast } = useToast();
  const [services, setServices] = useState<Service[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const refresh = useCallback(() => {
    if (!tenantId) return;
    setIsLoading(true);
    listServices(tenantId)
      .then(setServices)
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to load services.", "error");
      })
      .finally(() => setIsLoading(false));
  }, [tenantId, showToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSubmit = (input: ServiceInput): void => {
    if (!tenantId) return;
    setIsSaving(true);
    const request = editing === "new" ? createService(tenantId, input) : patchService(tenantId, (editing as Service).id, input);
    request
      .then(() => {
        showToast(editing === "new" ? "Service added." : "Service updated.", "success");
        setEditing(null);
        refresh();
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to save service.", "error");
      })
      .finally(() => setIsSaving(false));
  };

  const handleToggleActive = (service: Service): void => {
    if (!tenantId) return;
    patchService(tenantId, service.id, { isActive: !service.isActive })
      .then(() => {
        showToast(service.isActive ? "Service disabled." : "Service enabled.", "success");
        refresh();
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to update service.", "error");
      });
  };

  const handleDelete = (service: Service): void => {
    if (!tenantId) return;
    if (!window.confirm(`Delete "${service.name}"? This can't be undone.`)) return;
    deleteService(tenantId, service.id)
      .then(() => {
        showToast("Service deleted.", "success");
        refresh();
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to delete service.", "error");
      });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Service Catalog</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Changes here take effect on the AI's very next reply — nothing to publish.</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="flex h-11 items-center gap-1.5 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white transition active:scale-95"
        >
          <Plus className="h-4 w-4" />
          Add service
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400 dark:border-slate-800">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Duration</th>
              <th className="px-4 py-2 font-medium">Price</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {services.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                  {isLoading ? "Loading…" : "No services yet — add your first one."}
                </td>
              </tr>
            ) : (
              services.map((service) => (
                <tr key={service.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2.5 text-slate-700 dark:text-slate-200">{service.name}</td>
                  <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{service.durationMinutes} min</td>
                  <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{formatPrice(service.priceMinorUnits, service.currency)}</td>
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => handleToggleActive(service)}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium transition ${
                        service.isActive
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                          : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                      }`}
                    >
                      {service.isActive ? "Active" : "Inactive"}
                    </button>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEditing(service)}
                        aria-label={`Edit ${service.name}`}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition active:bg-slate-100 dark:text-slate-400 dark:active:bg-slate-800"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      {role === "tenant_admin" && (
                        <button
                          type="button"
                          onClick={() => handleDelete(service)}
                          aria-label={`Delete ${service.name}`}
                          className="flex h-9 w-9 items-center justify-center rounded-lg text-red-500 transition active:bg-red-50 dark:active:bg-red-950/40"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <ServiceFormModal
          initial={
            editing === "new"
              ? EMPTY_FORM
              : {
                  name: editing.name,
                  durationMinutes: editing.durationMinutes,
                  priceMinorUnits: editing.priceMinorUnits,
                  currency: editing.currency,
                  description: editing.description,
                  isActive: editing.isActive,
                }
          }
          onCancel={() => setEditing(null)}
          onSubmit={handleSubmit}
          isSaving={isSaving}
        />
      )}
    </div>
  );
}
