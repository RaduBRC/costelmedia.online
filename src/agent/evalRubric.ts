/**
 * Deterministic conversation-outcome classifier — the fixed rubric Radu
 * asked for so prompt/knowledge-base changes get judged by the same
 * yardstick every time ("nu evaluare din ochi"), not by an LLM's vibes on
 * whether a transcript "seems ok". Used by:
 *   - tests/eval/liveEval.test.ts — grades each eval scenario's actual
 *     outcome against its expected one after a real Groq run.
 *   - The planned "curator" bot (not built yet) — same three buckets will
 *     decide which real customer conversations become few-shot examples.
 *
 * The three buckets, exactly as specified:
 *   - success = a confirmed appointment with a valid date/time
 *   - partial = a follow-up was set without an appointment
 *   - failure = abandoned conversation / the bot repeated questions /
 *     the client got confused
 *
 * Honesty about what's actually measurable today: `success` and one
 * `failure` signal (repeated questions) are fully deterministic — they
 * read straight off processClientMessage's real return value and turn
 * history, no judgment call involved. `partial` has NO dedicated signal
 * yet: groqAgent.ts only has three tools (check_available_slots,
 * create_appointment, cancel_appointment) — there's no "record a
 * follow-up" action for the bot to signal "I couldn't book, but I told
 * them someone will call back." Until that tool exists (a real product
 * change, not an eval-harness change — needs Radu's go-ahead since it
 * changes what the live bot can do on every real call), `partial` here
 * is a text heuristic over the agent's final reply: a best-effort
 * proxy, not the same quality bar as the other two buckets. Every
 * result carries a `confidence` field for exactly this reason — treat
 * "success"/failure" results as reliable and "partial" results as a
 * hint to read the transcript yourself.
 */

export type ConversationOutcome = "success" | "partial" | "failure";

export interface ConversationOutcomeResult {
  outcome: ConversationOutcome;
  /** "high" for the two deterministic signals (booked / repeated-question failure); "low" for the partial-follow-up text heuristic and the abandoned-conversation fallback. */
  confidence: "high" | "low";
  /** Short human-readable reason, always present — never just a bare label, so a mismatch in the eval report is diagnosable without re-reading the whole transcript. */
  reason: string;
}

export interface EvalTurnResult {
  actionsTaken: string[];
  createdAppointmentId?: string | undefined;
  cancelledAppointmentId?: string | undefined;
  reply: string;
}

// Romanian phrases a reply uses when it can't book but is promising to
// follow up instead — deliberately narrow (real phrases this codebase's
// own prompts already favor, see promptBuilder.ts's tone guidance) rather
// than a broad keyword net that would also match "call me back" refusals
// or unrelated mentions of a phone call.
const FOLLOWUP_PHRASES = [
  "va sun",
  "va contact",
  "va anunt",
  "revin cu",
  "cineva va suna",
  "o sa va sun",
  "o sa revin",
  "vom reveni",
];

/**
 * A crude but real repeated-question detector: true if the bot's last two
 * replies both end in a question and share enough words to be "the same
 * question again" rather than two different questions that happen to
 * both be questions. Deliberately simple (word-overlap ratio, not
 * embeddings/LLM judgment) — this rubric's whole point is being fixed and
 * re-runnable, not clever.
 */
function isRepeatedQuestion(previousAgentReply: string | undefined, latestAgentReply: string): boolean {
  if (!previousAgentReply) return false;
  const isQuestion = (text: string): boolean => text.trim().endsWith("?");
  if (!isQuestion(previousAgentReply) || !isQuestion(latestAgentReply)) return false;

  const wordsOf = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\s]/gu, "")
        .split(/\s+/)
        .filter((word) => word.length > 3), // Skip short connector words (si, cu, la, ...) — they'd inflate overlap between two genuinely different questions.
    );
  const previousWords = wordsOf(previousAgentReply);
  const latestWords = wordsOf(latestAgentReply);
  if (previousWords.size === 0 || latestWords.size === 0) return false;

  let shared = 0;
  for (const word of previousWords) {
    if (latestWords.has(word)) shared++;
  }
  const overlapRatio = shared / Math.min(previousWords.size, latestWords.size);
  return overlapRatio >= 0.6;
}

/**
 * Classifies one finished eval scenario. `agentReplies` is every agent
 * turn in the conversation IN ORDER (not just the last one) — needed for
 * the repeated-question check, which looks at consecutive replies, not
 * just the final state.
 */
export function classifyConversationOutcome(finalResult: EvalTurnResult, agentReplies: string[]): ConversationOutcomeResult {
  // --- success: deterministic, reads straight off the real tool result ---
  if (finalResult.createdAppointmentId) {
    return {
      outcome: "success",
      confidence: "high",
      reason: `Booked appointment ${finalResult.createdAppointmentId} via create_appointment.`,
    };
  }

  // --- failure: repeated question, deterministic ---
  const lastReply = agentReplies[agentReplies.length - 1];
  const secondToLastReply = agentReplies[agentReplies.length - 2];
  if (lastReply && isRepeatedQuestion(secondToLastReply, lastReply)) {
    return {
      outcome: "failure",
      confidence: "high",
      reason: "The bot asked essentially the same question two turns in a row instead of progressing the booking.",
    };
  }

  // --- partial: text-heuristic proxy, see the file header's honesty note ---
  const finalReplyLower = (finalResult.reply ?? "").toLowerCase();
  if (FOLLOWUP_PHRASES.some((phrase) => finalReplyLower.includes(phrase))) {
    return {
      outcome: "partial",
      confidence: "low",
      reason: 'Reply promises a follow-up ("va sun"/"va contactam"-style phrasing) but no appointment was created — no dedicated follow-up tool exists yet to confirm this deterministically.',
    };
  }

  // --- failure: fallback — conversation ended with nothing booked and no
  // follow-up promised, i.e. genuinely abandoned/unresolved.
  return {
    outcome: "failure",
    confidence: "low",
    reason: "No appointment created, no repeated-question pattern detected, and no follow-up promise found in the final reply — treated as an abandoned/unresolved conversation.",
  };
}
