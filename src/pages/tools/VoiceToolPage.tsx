import VoiceCallSimulator from "../../components/VoiceCallSimulator.js";
import { useAuth } from "../../context/AuthContext.js";

export default function VoiceToolPage(): JSX.Element {
  const { tenantId } = useAuth();
  return <VoiceCallSimulator tenantId={tenantId ?? ""} />;
}
