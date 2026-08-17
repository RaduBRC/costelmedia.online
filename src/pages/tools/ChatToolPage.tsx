import ChatSimulator from "../../components/ChatSimulator.js";
import { useAuth } from "../../context/AuthContext.js";

export default function ChatToolPage(): JSX.Element {
  const { tenantId } = useAuth();
  return <ChatSimulator tenantId={tenantId ?? ""} />;
}
