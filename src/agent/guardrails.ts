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
 * prompt-injection phrasing. Always returns a string safe to hand to
 * buildSystemPrompt/callGroq as user content — never throws.
 */
export function sanitizeUserInput(input: string): string {
  let sanitized = stripControlCharacters(input).trim();

  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, REDACTION_MARKER);
  }

  if (sanitized.length > MAX_CHAT_INPUT_LENGTH) {
    sanitized = sanitized.slice(0, MAX_CHAT_INPUT_LENGTH);
  }

  return sanitized;
}
