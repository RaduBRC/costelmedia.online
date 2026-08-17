/**
 * Input hardening for anything that reaches the Groq system prompt as
 * untrusted user content: chat messages, voice transcripts, webhook
 * bodies. Two independent defenses, both applied by `sanitizeUserInput`:
 *   - length capping, so a caller can't blow up the prompt (or the LLM
 *     bill) with a massive payload.
 *   - stripping known prompt-injection phrasing, so a message can't talk
 *     the model into ignoring buildSystemPrompt's rules or leaking it.
 *
 * This is pattern-based, not a guarantee — a sufficiently creative
 * injection can still get through regex matching, the same way profanity
 * filters can be evaded. It raises the bar against the common, copy-pasted
 * attack phrasings without needing a second model call (which would add
 * real latency, unwelcome for the voice pipeline in particular).
 */

export const MAX_CHAT_INPUT_LENGTH = 500;

const REDACTION_MARKER = "[filtered]";

// ---------------------------------------------------------------------------
// PII redaction
//
// Applied inside sanitizeUserInput (below) — the same call site every
// caller already goes through — so this covers both what reaches Groq
// (third-party exposure) and what lands in conversation_logs.message in
// one place, with no separate opt-in needed. threatSentinel.ts's
// security_logs.raw_prompt is a *different* code path (middleware that
// runs before sanitizeUserInput does) and calls redactPii separately —
// see that file.
//
// Pattern-based, same caveat as the injection patterns above: this raises
// the bar, it isn't a guarantee against every way a person might type a
// CNP or phone number. Distinct markers per category (rather than one
// generic [PII_REDACTED]) so a transcript is still legible about *what
// kind* of thing was there, without keeping the actual value.
// ---------------------------------------------------------------------------

/**
 * Romanian CNP (Cod Numeric Personal): 13 digits — 1 (sex/century) + 2
 * (year) + 2 (month, 01-12) + 2 (day, 01-31) + 6 (county + sequence +
 * check digit). Validates shape (a real month/day), not the actual check
 * digit — good enough for "this looks like a CNP, redact it" without
 * implementing the full checksum algorithm.
 */
const CNP_PATTERN = /\b[1-9]\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{6}\b/g;

/** General IBAN shape (2-letter country + 2 check digits + up to 30 alphanumeric) — not just Romanian, since a client isn't necessarily banking in Romania. */
const IBAN_PATTERN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}\b/g;

/**
 * Deliberately conservative — a Romanian national number (0 + 9 digits) or
 * an international one (+ and 7-15 digits), each allowing single
 * space/dot/dash separators between digits. Loose enough to catch
 * "0722 123 456" or "+40 722 123 456"; tight enough not to swallow a
 * service duration ("30 minute") or a price ("150.00 RON") — those don't
 * have 10+ consecutive digit groups.
 */
const PHONE_PATTERNS: readonly RegExp[] = [/\b0\d(?:[\s.-]?\d){8}\b/g, /\+\d(?:[\s.-]?\d){6,14}\b/g];

/** Applied by both sanitizeUserInput (below) and threatSentinel.ts, on the same terms — see this section's header comment. */
export function redactPii(input: string): string {
  let redacted = input.replace(CNP_PATTERN, "[CNP_REDACTED]");
  redacted = redacted.replace(IBAN_PATTERN, "[IBAN_REDACTED]");
  redacted = redacted.replace(EMAIL_PATTERN, "[EMAIL_REDACTED]");
  for (const pattern of PHONE_PATTERNS) {
    redacted = redacted.replace(pattern, "[PHONE_REDACTED]");
  }
  return redacted;
}

/**
 * Each pattern targets a known injection technique: instruction override
 * ("ignore previous instructions"), role hijacking ("you are now a..."),
 * system-prompt exfiltration ("reveal your instructions"), and fake
 * chat-template boundary tokens some attacks use to impersonate a system
 * message.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+instructions?/gi,
  /disregard\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+instructions?/gi,
  /forget\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+instructions?/gi,
  /new\s+instructions?\s*[:-]/gi,
  /you\s+are\s+now\s+(a|an)\s+\w+/gi,
  /pretend\s+(that\s+)?you('re| are)\s+(a|an)\s+\w+/gi,
  /pretend\s+to\s+be\s+(a|an)\s+\w+/gi,
  /act\s+as\s+(if\s+you('re| are)|a|an)\s+(unrestricted|unfiltered|jailbroken|different)\s*\w*/gi,
  /reveal\s+(your\s+)?(system\s+)?(prompt|instructions)/gi,
  /show\s+me\s+(your\s+)?(system\s+)?(prompt|instructions)/gi,
  /what\s+(are|is)\s+your\s+(system\s+)?(prompt|instructions)/gi,
  /<\|?(im_start|im_end|system|assistant)\|?>/gi,
  /\[\[?system\]?\]/gi,
];

// Non-printable control characters (excluding \t \n \r, which are
// legitimate in normal text), expressed as hex escapes rather than literal
// bytes so the source file itself stays free of raw control characters.
// eslint-disable-next-line no-control-regex -- deliberately matching control-character ranges to strip them.
const CONTROL_CHARACTERS_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function stripControlCharacters(input: string): string {
  return input.replace(CONTROL_CHARACTERS_PATTERN, "");
}

/**
 * Truncates to MAX_CHAT_INPUT_LENGTH and strips/redacts known
 * prompt-injection phrasing and PII (CNP, IBAN, email, phone numbers).
 * Always returns a string safe to hand to buildSystemPrompt/callGroq as
 * user content — never throws. This is also, deliberately, what
 * processClientMessage passes to insertConversationLog — the redacted
 * version is what both Groq and our own database ever see, not the raw
 * input (see this file's PII section header comment for why that matters).
 * PII redaction runs before length truncation, so a match straddling the
 * cutoff still gets caught in full rather than half-truncated first.
 */
export function sanitizeUserInput(input: string): string {
  let sanitized = stripControlCharacters(input).trim();
  sanitized = redactPii(sanitized);

  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, REDACTION_MARKER);
  }

  if (sanitized.length > MAX_CHAT_INPUT_LENGTH) {
    sanitized = sanitized.slice(0, MAX_CHAT_INPUT_LENGTH);
  }

  return sanitized;
}
