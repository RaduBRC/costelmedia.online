/**
 * The AI Security & Threat Countermeasure module's scoring core. This is
 * an additive layer in front of the existing chat/voice pipeline, not a
 * replacement for it — src/agent/guardrails.ts's sanitizeUserInput()
 * (length cap + static injection-pattern stripping, applied inside
 * processClientMessage for every channel) is untouched and still runs
 * exactly as before on anything that gets past this module.
 *
 * The difference in role: guardrails.ts *sanitizes* (strips/redacts and
 * always lets the message through to the LLM); this module *decides*
 * (scores the message and can refuse to let it reach the LLM at all,
 * before spending a Groq call on it), and it writes an audit trail
 * (security_logs) that a human can later turn into new
 * blacklisted_patterns rows — see 011_security_logs.sql's header comment
 * for why that's "threat learning" here rather than an automated
 * pipeline.
 *
 * Pattern rules are DB-backed (blacklisted_patterns) and cached in memory
 * with a short TTL, so adding a new rule is an INSERT, not a deploy.
 */
import { getActiveBlacklistedPatterns, insertSecurityLog } from "../db/supabase.js";
import { redactPii } from "../agent/guardrails.js";
import type { SecurityChannel, ThreatCategory, ThreatEvaluation } from "../types/index.js";

const CACHE_TTL_MS = 5 * 60_000;
/** score >= this → blocked. See evaluateThreat's scoring comment for how score is derived. */
const BLOCK_THRESHOLD = 50;
/** Neutral, uninformative on purpose — never echoes back what was flagged or why, so a probing attacker learns nothing from the response about which rule they tripped. */
export const GENERIC_BLOCKED_REPLY =
  "I'm not able to help with that request. If you have a scheduling question, I'm happy to help with that instead.";

interface CompiledPattern {
  regex: RegExp;
  category: Exclude<ThreatCategory, "none">;
  severity: number;
  /** Original pattern source, for security_logs.matched_pattern — not the compiled RegExp, which isn't a useful log value. */
  source: string;
}

// Used only if the DB is unreachable when the cache needs refreshing (and
// there's no still-valid cached set to fall back to) — keeps the sentinel
// functioning, fail-safe rather than fail-open, through a transient
// Supabase outage. A small subset of 011_security_logs.sql's seed data,
// not a replacement for it.
const FALLBACK_PATTERNS: CompiledPattern[] = [
  { regex: /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+instructions?/i, category: "prompt_injection", severity: 60, source: "ignore instructions (fallback)" },
  { regex: /reveal\s+(your\s+)?(system\s+)?(prompt|instructions)/i, category: "system_leak", severity: 55, source: "reveal system prompt (fallback)" },
  { regex: /you\s+are\s+now\s+(a|an)\s+\w+/i, category: "role_hijack", severity: 50, source: "role hijack (fallback)" },
  { regex: /drop\s+table/i, category: "sql_injection_probe", severity: 45, source: "drop table (fallback)" },
];

let cachedPatterns: CompiledPattern[] | null = null;
let cacheExpiresAt = 0;
let refreshInFlight: Promise<CompiledPattern[]> | null = null;

async function refreshCache(): Promise<CompiledPattern[]> {
  try {
    const rows = await getActiveBlacklistedPatterns();
    const compiled = rows.map(
      (row): CompiledPattern => ({
        regex: new RegExp(row.pattern, "i"),
        category: row.category,
        severity: row.severity,
        source: row.pattern,
      }),
    );
    cachedPatterns = compiled.length > 0 ? compiled : FALLBACK_PATTERNS;
  } catch (error) {
    console.error("Threat Sentinel: failed to refresh blacklisted_patterns from Supabase; using fallback set.", error);
    cachedPatterns = cachedPatterns ?? FALLBACK_PATTERNS;
  }
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedPatterns;
}

async function getCompiledPatterns(): Promise<CompiledPattern[]> {
  if (cachedPatterns && Date.now() < cacheExpiresAt) {
    return cachedPatterns;
  }
  // Coalesce concurrent cache-miss callers into one refresh rather than
  // firing a Supabase query per in-flight request.
  refreshInFlight ??= refreshCache().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export interface ThreatCheckInput {
  message: string;
  ipAddress: string;
  tenantId?: string | null;
  channel: SecurityChannel;
}

/**
 * Scores `input.message` against the current pattern set, writes an
 * audit-trail row to security_logs (fire-and-forget — a logging failure
 * here must never fail or delay the request being evaluated), and
 * returns the verdict.
 *
 * Scoring: score = 0 (no match, category "none") or
 * min(100, highest-severity match + 10 × (additional matches)) — one bad
 * phrase can be enough on its own (a 60-severity match alone already
 * clears the 50 threshold), while several weaker matches can also add up
 * to a block even if no single one would have.
 */
export async function evaluateThreat(input: ThreatCheckInput): Promise<ThreatEvaluation> {
  const patterns = await getCompiledPatterns();
  // This runs as middleware *before* groqAgent.ts's sanitizeUserInput
  // ever sees the message — it's the one place a raw client message gets
  // examined pre-sanitization, and security_logs.rawPrompt used to store
  // it verbatim, PII included. redactPii doesn't touch any of the
  // injection/SQL-probe phrasing these patterns look for (the two never
  // overlap in shape), so redacting first changes nothing about scoring —
  // it's still the exact same audit trail, just without a caller's actual
  // CNP/IBAN/phone/email sitting in it.
  const text = redactPii(input.message);

  let bestSeverity = 0;
  let bestCategory: ThreatCategory = "none";
  let bestSource: string | null = null;
  let matchCount = 0;

  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      matchCount += 1;
      if (pattern.severity > bestSeverity) {
        bestSeverity = pattern.severity;
        bestCategory = pattern.category;
        bestSource = pattern.source;
      }
    }
  }

  const score = matchCount === 0 ? 0 : Math.min(100, bestSeverity + 10 * (matchCount - 1));
  const blocked = score >= BLOCK_THRESHOLD;
  const evaluation: ThreatEvaluation = { score, category: bestCategory, matchedPattern: bestSource, blocked };

  insertSecurityLog({
    ipAddress: input.ipAddress,
    tenantId: input.tenantId ?? null,
    channel: input.channel,
    rawPrompt: text,
    threatScore: score,
    threatCategory: bestCategory,
    matchedPattern: bestSource,
    status: blocked ? "blocked" : "allowed",
  }).catch((error: unknown) => {
    console.error("Threat Sentinel: failed to write security_logs entry.", error);
  });

  return evaluation;
}
