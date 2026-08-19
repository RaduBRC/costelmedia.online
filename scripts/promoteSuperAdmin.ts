#!/usr/bin/env -S node --experimental-strip-types
/**
 * Promotes an existing user (by email) to super admin — inserts into
 * platform_admins, which 021_super_admin_claim_sync.sql's trigger syncs
 * into that user's `is_super_admin` app_metadata immediately. The backend
 * (requireSuperAdmin, src/api/middleware/auth.ts) verifies every request
 * via supabase.auth.getUser(token), which re-fetches the live user record
 * rather than trusting the original JWT payload, so API access is granted
 * right away — no re-login needed. The *dashboard*'s nav link and route
 * guard (AuthContext.tsx) are the one place this lags: they read the
 * claim off the locally-cached session, which only updates on the user's
 * next sign-in or an explicit refreshSession() call. The user must
 * already have signed up (via /register or scripts/seedData.ts) — this
 * only grants the extra platform-wide capability, it doesn't create an
 * account.
 *
 * Usage:
 *   npm run promote:super-admin -- you@example.com
 */
import "dotenv/config";
import { getAuthUserByEmail, promoteToSuperAdmin } from "../src/db/supabase.ts";

const email = process.argv[2];

if (!email) {
  console.error("Usage: npm run promote:super-admin -- <email>");
  process.exit(1);
}

const user = await getAuthUserByEmail(email);
if (!user) {
  console.error(`No account found for ${email} — they need to register first (POST /api/v1/tenants/register, or scripts/seedData.ts).`);
  process.exit(1);
}

await promoteToSuperAdmin(user.id);
console.log(`${email} (${user.id}) is now a super admin.`);
console.log("API access (e.g. GET /api/super-admin/tenants) is effective immediately.");
console.log("The dashboard's own \"Platform\" nav link / /super-admin route needs a fresh sign-in (or session refresh) to pick it up.");
