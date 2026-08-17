import { ClientInsightsPanel } from "../components/Dashboard.js";
import { useAuth } from "../context/AuthContext.js";
import { useDashboardData } from "../hooks/useDashboardData.js";

export default function ClientsPage(): JSX.Element {
  const { tenantId } = useAuth();
  const data = useDashboardData(tenantId ?? "");

  return <ClientInsightsPanel data={data} />;
}
