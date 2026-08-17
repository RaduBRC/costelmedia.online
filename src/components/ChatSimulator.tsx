import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, CalendarPlus, CalendarSearch, CalendarX, Loader2, Send, User } from "lucide-react";
import { sendChatMessage } from "../lib/api.js";
import { useToast } from "./Toast.js";
import type { ToneAssessment } from "../types/index.js";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const ACTION_META: Record<string, { label: string; icon: typeof CalendarSearch }> = {
  checked_available_slots: { label: "Checked availability", icon: CalendarSearch },
  created_appointment: { label: "Booked appointment", icon: CalendarPlus },
  cancelled_appointment: { label: "Cancelled appointment", icon: CalendarX },
};

function ToneMeter({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">{label}</span>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((step) => (
          <span
            key={step}
            className={`h-2 w-4 rounded-sm ${
              step <= value ? "bg-violet-500 dark:bg-violet-400" : "bg-slate-200 dark:bg-slate-800"
            }`}
          />
        ))}
      </div>
      <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{value}/5</span>
    </div>
  );
}

export default function ChatSimulator({ tenantId }: { tenantId: string }): JSX.Element {
  const { showToast } = useToast();
  const [clientPhone, setClientPhone] = useState("+15555550123");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tone, setTone] = useState<ToneAssessment | null>(null);
  const [actionsTaken, setActionsTaken] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || isSending) {
      return;
    }
    if (!tenantId.trim()) {
      showToast("Enter a tenant id in the header before chatting — the bot is wired to live data, not a demo tenant.", "error");
      return;
    }

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: trimmed };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setIsSending(true);

    try {
      const result = await sendChatMessage(tenantId.trim(), clientPhone.trim(), trimmed);
      setTone(result.toneAssessment);
      setActionsTaken(result.actionsTaken);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: result.reply }]);
      if (result.actionsTaken.length > 0) {
        showToast(`Bot took action: ${result.actionsTaken.join(", ")}`, "success");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Failed to reach the chat API.", "error");
    } finally {
      setIsSending(false);
    }
  }, [draft, isSending, tenantId, clientPhone, showToast]);

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <div className="flex h-[32rem] flex-col rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            Client phone
            <input
              value={clientPhone}
              onChange={(event) => {
                setClientPhone(event.target.value);
              }}
              className="min-h-12 w-40 rounded-md border border-slate-300 bg-transparent px-2 py-1 text-base text-slate-900 outline-none focus:border-violet-500 sm:min-h-8 sm:text-xs dark:border-slate-700 dark:text-slate-100"
            />
          </label>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <p className="text-sm text-slate-400 dark:text-slate-500">
              Send a message as a client would — e.g. “Do you have anything open Thursday afternoon for a haircut?”
            </p>
          )}
          {messages.map((message) => (
            <div key={message.id} className={`flex gap-2 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
              {message.role === "assistant" && (
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-300">
                  <Bot className="h-4 w-4" />
                </div>
              )}
              <div
                className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  message.role === "user"
                    ? "bg-violet-600 text-white"
                    : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100"
                }`}
              >
                {message.content}
              </div>
              {message.role === "user" && (
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                  <User className="h-4 w-4" />
                </div>
              )}
            </div>
          ))}
          <div ref={scrollAnchorRef} />
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSend();
          }}
          className="flex items-center gap-2 border-t border-slate-200 p-3 dark:border-slate-800"
        >
          <input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder="Type a message as the client…"
            className="min-h-12 flex-1 rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700"
          />
          <button
            type="submit"
            disabled={isSending}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-white transition active:scale-95 active:bg-violet-700 hover:bg-violet-500 disabled:opacity-50"
            aria-label="Send message"
          >
            {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </form>
      </div>

      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Detected tone</h3>
          {tone ? (
            <div className="space-y-2">
              <ToneMeter label="Formality" value={tone.formality} />
              <ToneMeter label="Urgency" value={tone.urgency} />
              <p className="mt-2 text-xs italic text-slate-500 dark:text-slate-400">“{tone.toneNote}”</p>
            </div>
          ) : (
            <p className="text-xs text-slate-400 dark:text-slate-500">No messages analyzed yet.</p>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Live tool calls</h3>
          {actionsTaken.length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-slate-500">No tool calls made yet this turn.</p>
          ) : (
            <ul className="space-y-2">
              {actionsTaken.map((action, index) => {
                const meta = ACTION_META[action];
                const Icon = meta?.icon ?? CalendarSearch;
                return (
                  <li
                    key={`${action}-${index}`}
                    className="flex items-center gap-2 rounded-lg bg-violet-50 px-3 py-2 text-xs font-medium text-violet-700 dark:bg-violet-950/50 dark:text-violet-300"
                  >
                    <Icon className="h-4 w-4" />
                    {meta?.label ?? action}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
