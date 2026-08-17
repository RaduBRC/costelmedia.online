import WidgetEmbedPanel from "../../components/WidgetEmbedPanel.js";
import { useAuth } from "../../context/AuthContext.js";

export default function WidgetToolPage(): JSX.Element {
  const { tenantId } = useAuth();
  return <WidgetEmbedPanel tenantId={tenantId ?? ""} />;
}
