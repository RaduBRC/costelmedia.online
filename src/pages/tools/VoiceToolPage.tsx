/**
 * Fetches the current tenant once (a plain GET, not useDashboardData's
 * polling hook — this page doesn't need live metrics/appointments/clients,
 * just the tenant record) and passes it down so VoiceCallSimulator can
 * greet the caller with THIS tenant's real getVoiceGreeting() output
 * instead of a generic placeholder — see that component's own comments.
 */
import { useEffect, useState } from "react";
import VoiceCallSimulator from "../../components/VoiceCallSimulator.js";
import { useAuth } from "../../context/AuthContext.js";
import { getTenant } from "../../lib/api.js";
import type { Tenant } from "../../types/index.js";

export default function VoiceToolPage(): JSX.Element {
  const { tenantId } = useAuth();
  const [tenant, setTenant] = useState<Tenant | null>(null);

  useEffect(() => {
    setTenant(null);
    if (!tenantId) return;
    let cancelled = false;
    getTenant(tenantId)
      .then((fetched) => {
        if (!cancelled) setTenant(fetched);
      })
      .catch(() => {
        // Best-effort — VoiceCallSimulator falls back to a generic
        // greeting if `tenant` stays null, so a failed fetch here isn't
        // fatal to trying the simulator.
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  return <VoiceCallSimulator tenantId={tenantId ?? ""} tenant={tenant} />;
}
