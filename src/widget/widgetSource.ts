/**
 * Standalone, framework-free embeddable chat widget. Compiled by
 * vite.widget.config.ts (IIFE format, no external deps) into
 * public/widget.js, served by src/api/routes/widget.ts at GET /widget.js,
 * and embedded on arbitrary third-party business websites via:
 *
 *   <script src="https://<api-host>/widget.js" data-tenant-id="TENANT_ID" async></script>
 *
 * Everything below runs in the host page's global scope, so:
 *  - No React/JSX, no bundled dependencies — plain DOM APIs only.
 *  - All injected class names are prefixed (`aibp-`) to avoid colliding
 *    with the host page's own CSS.
 *  - Reply text is always inserted via `textContent`, never `innerHTML` —
 *    the AI's reply is untrusted text as far as this script is concerned.
 *  - The API origin is derived from this script's own `src`, never
 *    hardcoded, so the same bundle works from any domain it's served on.
 */

// Captured synchronously, at the top level of the script's first (and
// only) execution. This is the one moment `document.currentScript` is
// guaranteed correct for a `<script async>` tag — read it any later
// (inside a callback, a promise, DOMContentLoaded) and it may already be
// null or point at a different script. Everything that needs to know
// which <script> tag loaded this file must derive it from this constant,
// not from a fresh `document.currentScript` lookup.
const OWN_SCRIPT_ELEMENT: HTMLScriptElement | null = document.currentScript as HTMLScriptElement | null;

function resolveScriptElement(): HTMLScriptElement | null {
  if (OWN_SCRIPT_ELEMENT) {
    return OWN_SCRIPT_ELEMENT;
  }
  // Fallback for the rare host page that loads this script in a way that
  // never sets document.currentScript (e.g. injected via innerHTML, or a
  // tag manager that clones/re-creates the node). Matches on the known
  // filename regardless of host, so it still works when proxied/renamed
  // query strings are appended.
  return document.querySelector<HTMLScriptElement>('script[src*="widget.js"]');
}

function init(): void {
  const scriptEl = resolveScriptElement();
  if (!scriptEl) {
    console.error("[ai-booking-widget] Could not locate its own <script> tag; aborting.");
    return;
  }

  const tenantId = scriptEl.dataset["tenantId"];
  if (!tenantId) {
    console.error('[ai-booking-widget] Missing required data-tenant-id attribute on the <script> tag.');
    return;
  }

  let apiOrigin: string;
  try {
    apiOrigin = new URL(scriptEl.src).origin;
  } catch {
    console.error("[ai-booking-widget] Could not determine API origin from the widget script's src.");
    return;
  }

  mount(tenantId, apiOrigin);
}

const PHONE_STORAGE_KEY_PREFIX = "aibp:phone:";
const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

function getStoredPhone(tenantId: string): string | null {
  try {
    return localStorage.getItem(PHONE_STORAGE_KEY_PREFIX + tenantId);
  } catch {
    // Storage can throw in locked-down embeds (sandboxed iframes, private
    // browsing in some browsers) — treat as "no stored number" rather than
    // breaking the widget.
    return null;
  }
}

function storePhone(tenantId: string, phone: string): void {
  try {
    localStorage.setItem(PHONE_STORAGE_KEY_PREFIX + tenantId, phone);
  } catch {
    // Best-effort only; the widget still works within the session if this fails.
  }
}

interface ChatMessage {
  role: "visitor" | "agent" | "error";
  text: string;
}

function mount(tenantId: string, apiOrigin: string): void {
  const root = document.createElement("div");
  root.className = "aibp-root";
  root.innerHTML = ""; // start empty; every node below is built via createElement/textContent.

  injectStyles();

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "aibp-toggle";
  toggleButton.setAttribute("aria-label", "Open chat");
  toggleButton.textContent = "💬";

  const panel = document.createElement("div");
  panel.className = "aibp-panel aibp-hidden";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Chat");

  const header = document.createElement("div");
  header.className = "aibp-header";
  const headerTitle = document.createElement("span");
  headerTitle.textContent = "Chat with us";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "aibp-close";
  closeButton.setAttribute("aria-label", "Close chat");
  closeButton.textContent = "✕";
  header.append(headerTitle, closeButton);

  const body = document.createElement("div");
  body.className = "aibp-body";

  panel.append(header, body);
  root.append(panel, toggleButton);
  document.body.appendChild(root);

  let open = false;
  function setOpen(next: boolean): void {
    open = next;
    panel.classList.toggle("aibp-hidden", !open);
    toggleButton.setAttribute("aria-label", open ? "Close chat" : "Open chat");
  }
  toggleButton.addEventListener("click", () => setOpen(!open));
  closeButton.addEventListener("click", () => setOpen(false));

  const storedPhone = getStoredPhone(tenantId);
  if (storedPhone) {
    renderChatView(body, tenantId, apiOrigin, storedPhone);
  } else {
    renderPhoneGate(body, tenantId, apiOrigin);
  }
}

function renderPhoneGate(body: HTMLElement, tenantId: string, apiOrigin: string): void {
  body.textContent = "";

  const intro = document.createElement("p");
  intro.className = "aibp-intro";
  intro.textContent = "Enter your phone number to start chatting.";

  const form = document.createElement("form");
  form.className = "aibp-phone-form";

  const input = document.createElement("input");
  input.type = "tel";
  input.className = "aibp-phone-input";
  input.placeholder = "+1 555 123 4567";
  input.autocomplete = "tel";
  input.required = true;

  const hint = document.createElement("p");
  hint.className = "aibp-hint";
  hint.textContent = "";

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "aibp-primary-button";
  submitButton.textContent = "Start chat";

  form.append(input, submitButton);
  body.append(intro, form, hint);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const phone = input.value.trim();
    if (!PHONE_PATTERN.test(phone)) {
      hint.textContent = "Please enter a valid phone number, e.g. +15551234567.";
      return;
    }
    storePhone(tenantId, phone);
    renderChatView(body, tenantId, apiOrigin, phone);
  });
}

function renderChatView(body: HTMLElement, tenantId: string, apiOrigin: string, phoneNumber: string): void {
  body.textContent = "";

  const messageList = document.createElement("div");
  messageList.className = "aibp-messages";

  const form = document.createElement("form");
  form.className = "aibp-message-form";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "aibp-message-input";
  input.placeholder = "Type a message…";
  input.autocomplete = "off";
  input.required = true;
  // Matches MAX_CHAT_INPUT_LENGTH (src/agent/guardrails.ts) — the backend
  // enforces this regardless, but bounding it client-side too means a
  // visitor sees the cutoff as they type instead of a rejection after
  // hitting send.
  input.maxLength = 500;

  const sendButton = document.createElement("button");
  sendButton.type = "submit";
  sendButton.className = "aibp-primary-button";
  sendButton.textContent = "Send";

  form.append(input, sendButton);
  body.append(messageList, form);

  function appendMessage(message: ChatMessage): void {
    const bubble = document.createElement("div");
    bubble.className = `aibp-bubble aibp-bubble-${message.role}`;
    // XSS safety: the agent reply and the visitor's own text are both
    // untrusted as far as the DOM is concerned — textContent only, never
    // innerHTML.
    bubble.textContent = message.text;
    messageList.appendChild(bubble);
    messageList.scrollTop = messageList.scrollHeight;
  }

  let sending = false;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (sending) {
      return;
    }
    const text = input.value.trim();
    if (!text) {
      return;
    }

    appendMessage({ role: "visitor", text });
    input.value = "";
    sending = true;
    sendButton.disabled = true;

    const typingBubble = document.createElement("div");
    typingBubble.className = "aibp-bubble aibp-bubble-agent aibp-typing";
    typingBubble.textContent = "…";
    messageList.appendChild(typingBubble);
    messageList.scrollTop = messageList.scrollHeight;

    fetch(`${apiOrigin}/api/v1/widget/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, phoneNumber, message: text }),
    })
      .then(async (response) => {
        typingBubble.remove();
        const data = (await response.json().catch(() => null)) as { reply?: string; error?: string } | null;
        if (!response.ok || !data) {
          appendMessage({
            role: "error",
            text: data?.error ?? "Sorry, something went wrong. Please try again.",
          });
          return;
        }
        appendMessage({ role: "agent", text: data.reply ?? "" });
      })
      .catch(() => {
        typingBubble.remove();
        appendMessage({ role: "error", text: "Sorry, something went wrong. Please try again." });
      })
      .finally(() => {
        sending = false;
        sendButton.disabled = false;
        input.focus();
      });
  });
}

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) {
    return;
  }
  stylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .aibp-root, .aibp-root * { box-sizing: border-box; }
    .aibp-root {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      color: #1a1a1a;
    }
    .aibp-toggle {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: none;
      background: #2563eb;
      color: #fff;
      font-size: 24px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
    }
    .aibp-toggle:hover { background: #1d4ed8; }
    .aibp-panel {
      position: absolute;
      bottom: 68px;
      right: 0;
      width: 320px;
      max-width: calc(100vw - 40px);
      height: 440px;
      max-height: calc(100vh - 120px);
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .aibp-hidden { display: none; }
    .aibp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: #2563eb;
      color: #fff;
      font-weight: 600;
    }
    .aibp-close {
      background: transparent;
      border: none;
      color: #fff;
      font-size: 16px;
      cursor: pointer;
      padding: 4px;
    }
    .aibp-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 12px;
      overflow: hidden;
    }
    .aibp-intro { margin: 0 0 10px; color: #444; }
    .aibp-hint { margin: 8px 0 0; color: #dc2626; font-size: 12px; min-height: 14px; }
    .aibp-phone-form, .aibp-message-form {
      display: flex;
      gap: 8px;
    }
    .aibp-phone-input, .aibp-message-input {
      flex: 1;
      padding: 8px 10px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 14px;
      color: #1a1a1a;
      background: #fff;
    }
    .aibp-primary-button {
      padding: 8px 14px;
      border: none;
      border-radius: 8px;
      background: #2563eb;
      color: #fff;
      font-weight: 600;
      cursor: pointer;
    }
    .aibp-primary-button:hover { background: #1d4ed8; }
    .aibp-primary-button:disabled { background: #93c5fd; cursor: default; }
    .aibp-messages {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 10px;
      padding-right: 2px;
    }
    .aibp-bubble {
      max-width: 85%;
      padding: 8px 12px;
      border-radius: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .aibp-bubble-visitor {
      align-self: flex-end;
      background: #2563eb;
      color: #fff;
      border-bottom-right-radius: 2px;
    }
    .aibp-bubble-agent {
      align-self: flex-start;
      background: #f1f5f9;
      color: #1a1a1a;
      border-bottom-left-radius: 2px;
    }
    .aibp-bubble-error {
      align-self: flex-start;
      background: #fef2f2;
      color: #b91c1c;
      border-bottom-left-radius: 2px;
    }
    .aibp-typing { opacity: 0.6; }
  `;
  document.head.appendChild(style);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  // The DOM is already parsed by the time this ran (common for `async`
  // scripts that finish downloading after parsing completes) — safe to
  // mount immediately.
  init();
}
