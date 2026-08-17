import AnalyticsView from "../components/AnalyticsView.js";
import { useAuth } from "../context/AuthContext.js";

export default function AnalyticsPage(): JSX.Element {
  const { tenantId } = useAuth();
  return <AnalyticsView tenantId={tenantId ?? ""} />;
}
