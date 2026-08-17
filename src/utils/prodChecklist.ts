/**
 * Boot-time production readiness checks: required env vars, secret
 * strength, CORS configuration, and expected database indexes. Run once
 * from src/server/index.ts before the server starts accepting traffic —
 * see runProductionChecklist's doc comment for exit behavior.
 */
import { listIndexNames } from "../db/supabase.js";

export type ChecklistSeverity = "critical" | "warning";

export interface ChecklistCheck {
  name: string;
  severity: ChecklistSeverity;
  passed: boolean;
  detail?: string;
}

export interface ChecklistResult {
  /** false if any *critical* check failed — warnings alone don't fail the checklist. */
  ok: boolean;
  checks: ChecklistCheck[];
}

// ---------------------------------------------------------------------------
// Secret entropy
// ---------------------------------------------------------------------------

/** Shannon entropy in bits per character — low for repeated/placeholder values ("changeme", "aaaa..."), higher for real random keys. */
function shannonEntropyBitsPerChar(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

const PLACEHOLDER_VALUES = new Set(["changeme", "your-api-key-here", "placeholder", "xxxxxxxxxx", "secret", "password", "test-key"]);

const MIN_SECRET_LENGTH = 20;
const MIN_SECRET_ENTROPY_BITS_PER_CHAR = 3.0;

function isStrongSecret(value: string): boolean {
  if (value.length < MIN_SECRET_LENGTH) {
    return false;
  }
  if (PLACEHOLDER_VALUES.has(value.toLowerCase())) {
    return false;
  }
  return shannonEntropyBitsPerChar(value) >= MIN_SECRET_ENTROPY_BITS_PER_CHAR;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const REQUIRED_ENV_VARS = ["GROQ_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"] as const;

const OPTIONAL_FEATURE_ENV_VARS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "FCM_PROJECT_ID",
  "APNS_KEY_ID",
  "WEB_PUSH_VAPID_PRIVATE_KEY",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
] as const;

const ENTROPY_CHECKED_ENV_VARS = ["GROQ_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "TWILIO_AUTH_TOKEN", "WEB_PUSH_VAPID_PRIVATE_KEY", "DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY"] as const;

const EXPECTED_INDEXES = [
  "appointments_tenant_start_idx",
  "appointments_tenant_channel_idx",
  "client_profiles_tenant_phone_idx",
  "conversation_logs_client_recent_idx",
  "push_subscriptions_user_platform_idx",
  "call_transcripts_tenant_created_idx",
] as const;

function checkRequiredEnvVars(): ChecklistCheck[] {
  return REQUIRED_ENV_VARS.map((name) => {
    const value = process.env[name];
    return {
      name: `env:${name}`,
      severity: "critical",
      passed: Boolean(value),
      ...(value ? {} : { detail: "Not set." }),
    };
  });
}

function checkOptionalFeatureEnvVars(): ChecklistCheck[] {
  return OPTIONAL_FEATURE_ENV_VARS.map((name) => ({
    name: `env:${name}`,
    severity: "warning",
    passed: Boolean(process.env[name]),
    ...(process.env[name] ? {} : { detail: "Not set — the feature that depends on it will be unavailable." }),
  }));
}

function checkSecretStrength(): ChecklistCheck[] {
  return ENTROPY_CHECKED_ENV_VARS.filter((name) => Boolean(process.env[name])).map((name) => {
    const value = process.env[name] ?? "";
    const strong = isStrongSecret(value);
    return {
      name: `secret-strength:${name}`,
      severity: "critical",
      passed: strong,
      ...(strong ? {} : { detail: "Looks like a placeholder or low-entropy value, not a real secret." }),
    };
  });
}

function checkCorsConfiguration(): ChecklistCheck {
  const allowedOrigins = process.env["ALLOWED_ORIGINS"];
  const isProduction = process.env["NODE_ENV"] === "production";
  const wildcard = !allowedOrigins || allowedOrigins.trim() === "*";

  return {
    name: "cors-configuration",
    severity: "critical",
    passed: !isProduction || !wildcard,
    ...(isProduction && wildcard
      ? { detail: "ALLOWED_ORIGINS is unset or '*' in production — set it to an explicit comma-separated origin list." }
      : {}),
  };
}

async function checkDatabaseIndexes(): Promise<ChecklistCheck[]> {
  try {
    const existingIndexes = new Set(await listIndexNames());
    return EXPECTED_INDEXES.map((name) => ({
      name: `index:${name}`,
      severity: "warning",
      passed: existingIndexes.has(name),
      ...(existingIndexes.has(name) ? {} : { detail: "Expected index not found — has every migration been applied?" }),
    }));
  } catch (error) {
    return [
      {
        name: "index:introspection",
        severity: "warning",
        passed: false,
        detail: `Could not query indexes: ${error instanceof Error ? error.message : "unknown error"}`,
      },
    ];
  }
}

/**
 * Runs all boot-time checks. Callers (src/server/index.ts) decide what to
 * do with a failing result — this function only reports, it never exits
 * the process itself.
 */
export async function runProductionChecklist(): Promise<ChecklistResult> {
  const checks: ChecklistCheck[] = [
    ...checkRequiredEnvVars(),
    ...checkOptionalFeatureEnvVars(),
    ...checkSecretStrength(),
    checkCorsConfiguration(),
    ...(await checkDatabaseIndexes()),
  ];

  const ok = checks.every((check) => check.passed || check.severity !== "critical");
  return { ok, checks };
}
