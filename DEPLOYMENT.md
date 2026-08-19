# Deployment Guide

Step-by-step setup for local development and production deployment of the
AI Booking Platform: a Supabase-backed multi-tenant scheduling API (Express
+ Groq + Google Calendar + Twilio + a voice agent) and a Vite/React
dashboard, deployed as two separate services (Render for the API, Vercel
for the frontend — see `render.yaml` / `vercel.json`).

## 1. Prerequisites

- Node.js 20+ (the repo targets 20; local dev has been done on 22).
- A [Supabase](https://supabase.com) project (the free tier covers
  everything this app needs).
- Accounts for whichever integrations you actually plan to use: Groq,
  Google Cloud (service account + Calendar API), Twilio, Deepgram,
  ElevenLabs, Firebase Cloud Messaging, Apple Push Notification service.
  None of these are required to boot the app — see §4, "what's actually
  required."

## 2. Supabase setup

1. Create a new Supabase project. Note its **Project URL** and, from
   Project Settings → API, its **`service_role` secret key** and **`anon`
   publishable key**.
2. Run every file in `supabase/migrations/` **in filename order** — they're
   numbered for a reason; several later migrations alter tables or add
   columns earlier ones created. Two ways to do this:
   - **Supabase CLI** (recommended): `supabase link --project-ref <ref>`
     then `supabase db push`.
   - **SQL Editor**: paste and run each file's contents, in order, from
     `001_init.sql` through `010_index_introspection.sql`.

   | # | File | What it adds |
   |---|------|---------------|
   | 001 | `001_init.sql` | `tenants`, `client_profiles`, `appointments` |
   | 002 | `002_push_subscriptions.sql` | Web/Android/iOS push registrations |
   | 003 | `003_security_rls.sql` | `tenant_members`, `platform_admins`, RBAC RLS policies, `auth.current_tenant_id()`/`current_tenant_role()`, `tenants.api_key_hash` |
   | 004 | `004_twilio_channel.sql` | Per-tenant Twilio routing columns |
   | 005 | `005_reminder_tracking.sql` | Reminder/feedback flags on `appointments` |
   | 006 | `006_conversation_logs.sql` | Per-message tone history |
   | 007 | `007_booking_channel.sql` | `appointments.booking_channel` |
   | 008 | `008_call_transcripts.sql` | Voice call transcripts |
   | 009 | `009_analytics_views.sql` | `v_tenant_daily_stats` view, `get_tone_distribution()` RPC |
   | 010 | `010_index_introspection.sql` | `list_index_names()` RPC (used by the prod-readiness checklist) |

3. **Enable email/password auth** (Authentication → Providers) — it's on
   by default for new projects, but confirm it if you've changed provider
   settings.
4. You do **not** need to create any tenants manually — use the seed
   script (§5) or the registration API (§6) instead.

## 3. Environment variables

Copy `.env.example` to `.env` and fill in what you need. Everything below
is read directly from `process.env` (no config file, no `dotenv` — for
local dev, either export vars in your shell or run Node with
`--env-file=.env`).

| Variable | Required for | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Everything backend-side | The service role key bypasses RLS by design — never expose it to the frontend. |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Frontend build | Same project, different (public-safe) key. Required at **build time** — Vite bakes these into the bundle. |
| `GROQ_API_KEY` | The AI agent (chat, SMS, voice) | Without it, `processClientMessage` fails gracefully with a fallback reply rather than crashing. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Calendar booking, FCM push | Create a service account in Google Cloud Console, enable the Calendar API, then share each tenant's calendar with the service account's email as "Make changes to events." |
| `FCM_PROJECT_ID` | Android push | Same Google Cloud project as the service account above. |
| `APNS_*` | iOS Live Activity push | Requires an Apple Developer account and a `.p8` auth key. |
| `WEB_PUSH_VAPID_*` | Web push | Generate a VAPID key pair once (e.g. via `npx web-push generate-vapid-keys`) and reuse it. |
| `TWILIO_*` | SMS/WhatsApp/voice | Platform-level fallback credentials; individual tenants can override via `tenants.twilio_account_sid`/`twilio_auth_token`/`twilio_phone_number`. |
| `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | The voice call agent only | Free tiers cover light usage. |
| `PORT` | Local dev | Defaults to `8787`. |
| `ALLOWED_ORIGINS` | **Production** | Comma-separated origin allowlist for CORS. `src/utils/prodChecklist.ts` treats an unset/wildcard value as a **critical** failure once `NODE_ENV=production`. |
| `PUBLIC_WEBHOOK_BASE_URL` | Only if needed | Overrides the host Twilio-signature verification reconstructs the webhook URL against — set this if a proxy changes what Express sees. |
| `CRON_ENABLED` | Local dev | Set to `false` to stop the in-process reminder scheduler from sending real reminders against a shared dev database. |
| `SEED_GOOGLE_CALENDAR_ID` | Seed script only | Overrides the placeholder calendar ID `scripts/seedData.ts` uses for the demo tenant. |

**What's actually required to boot the app at all:** just
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (backend) and
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (frontend build). Everything
else degrades gracefully — the health check (`GET /health`) reports each
integration's status individually — until you configure it.

## 4. Local development

```bash
npm install
cp .env.example .env   # then fill in at least the Supabase vars above

npm run seed            # optional — populates a demo tenant (see §5)

npm run dev:all         # Vite dev server (5173) + Express API (8787), concurrently
```

`vite.config.ts` proxies `/api/*` to the Express server automatically in
dev, so the frontend's relative `fetch('/api/...')` calls just work.

Individually: `npm run dev` (frontend only) or
`npm run dev:server` (backend only — compiles then runs `dist/server/index.js`).

## 5. Seed data

`scripts/seedData.ts` creates a demo tenant ("Metro Dental Clinic"), an
admin user, 5 client profiles (formality scores 1–5), and 10 sample
appointments (7 confirmed, 3 cancelled) — enough to exercise the dashboard,
chat simulator, and analytics views without needing real bookings.

```bash
npm run seed          # safe to re-run — reuses the existing tenant/user if found
npm run seed:reset     # deletes the existing demo tenant + admin user first, then recreates both
```

It needs only `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` — it never calls
Groq, Google Calendar, or Twilio (appointments are inserted directly, not
mirrored to a real calendar). On success it prints the tenant ID and the
admin login:

```
admin@metrodental.com / Password123!
```

Sign in with those at the dashboard to see the seeded data. (Not
`ts-node` — see the comment at the top of `scripts/seedData.ts` for why;
short version: `ts-node` 10.x's ESM loader doesn't work on modern Node,
confirmed empirically, so the script runs via Node's own
`--experimental-strip-types` instead. `npm run seed` handles this for
you.)

## 6. Provisioning additional tenants

Beyond the seed script, new tenants can self-register two ways — through
the dashboard's `/register` page, or directly against the API:

```bash
curl -X POST https://<your-api-host>/api/v1/tenants/register \
  -H "Content-Type: application/json" \
  -d '{
    "businessName": "Sunrise Family Dental",
    "businessType": "clinic",
    "adminEmail": "owner@sunrisedental.example",
    "adminPassword": "a-strong-password",
    "googleCalendarId": "owner@sunrisedental.example"
  }'
```

`googleCalendarId` is optional — it defaults to `"primary"` if omitted, so a
brand-new business owner doesn't need to already know their Google Calendar
ID before their first login (they can connect Google Calendar properly
later from `/admin/settings`).

This is a public, unauthenticated, aggressively rate-limited endpoint (5
requests / 15 minutes / IP — see `signupRateLimiter` in
`src/api/middleware/security.ts`), since anyone can hit it to create an
account. It creates the Supabase Auth user and the `tenants` row, which a
database trigger (`003_security_rls.sql`) automatically links via
`tenant_members` — no separate step needed. The new admin then signs in
through the normal dashboard login and lands on `/admin/dashboard`.

**Google/GitHub sign-up** goes through a second, authenticated path
instead: `loginWithGoogle()`/`loginWithGithub()` (Supabase Auth's own
OAuth, via the shared `OAuthButtons.tsx` on both `/login` and `/register`)
create only the `auth.users` row, so either "Continue with…" button
redirects to `/onboarding`, which collects the business name/type and
calls `POST /api/v1/tenants/onboard` (requires a valid session, no request
body needed beyond the business info) to create the tenant for the
now-authenticated user. `/onboarding` is idempotent — a returning user who
already owns a tenant is bounced straight through to `/admin/dashboard`
with no form shown. This same path handles *any* provider identically,
since it only ever looks at "is there a session," never which provider
produced it — adding a new one later needs no changes here.

Each provider needs enabling under Authentication → Providers in the
Supabase dashboard before its button does anything:

- **Google** — needs its own OAuth client (separate from the per-tenant
  Google **Calendar** connection in `/admin/settings` — see §7's note in
  `.env.example` about `GOOGLE_OAUTH_CLIENT_ID`, which is for Calendar
  sync, not sign-in). Register Supabase's callback URL
  (`https://<project-ref>.supabase.co/auth/v1/callback`) as an authorized
  redirect URI on that client.
- **GitHub** — create an OAuth App under GitHub → Settings → Developer
  settings → OAuth Apps, with the same Supabase callback URL as its
  "Authorization callback URL," then paste its Client ID/Secret into
  Supabase's GitHub provider config.

Either way, every new tenant automatically gets its owner added to
`tenant_members` with `tenant_role = 'tenant_admin'` — a database trigger
(`seed_owner_as_tenant_admin`, `003_security_rls.sql`) fires on every
`tenants` insert and handles this without any application code needing to
do it explicitly.

## 6a. Roles & Super Admin

Two roles exist, enforced at three layers (Postgres RLS, Express
middleware, and frontend route guards — the first is the one that
actually matters; the other two are UX):

- **`tenant_admin`** (per-tenant, via `tenant_members.tenant_role`) — full
  access to their own tenant's data only. RLS policies across every table
  scope every query to `current_tenant_id()`, read from the caller's JWT
  `app_metadata` — Tenant A's admin cannot see Tenant B's appointments,
  call logs, or settings under any circumstance, including a compromised
  API key, since the database itself enforces the boundary.
- **`SUPER_ADMIN`** (platform-wide, via the separate `platform_admins`
  table — *not* a `tenant_role` value, since a super admin isn't "an
  admin of tenant X," they bypass tenant scoping entirely) — can read
  across all tenants. Every RLS policy in the schema already includes an
  `or public.is_super_admin()` clause. On the app side, `GET
  /api/super-admin/tenants` (gated by the `requireSuperAdmin` Express
  middleware) and the `/super-admin` dashboard page are the only things
  currently built on top of this — a read-only list of every tenant on
  the platform. A regular `tenant_admin` never even sees the "Platform"
  nav section (`DashboardLayout.tsx`), and hitting the route directly
  bounces them back to their own dashboard (`ProtectedSuperAdminRoute.tsx`);
  the real enforcement is server-side.

**Promoting an account to `SUPER_ADMIN`:**

```bash
npm run promote:super-admin -- you@example.com
```

This looks the user up by email in Supabase Auth and inserts a row into
`platform_admins`, which a trigger (`021_super_admin_claim_sync.sql`)
syncs into that user's `app_metadata.is_super_admin` immediately. API
access takes effect right away — `requireSuperAdmin`
(`src/api/middleware/auth.ts`) verifies every request via
`supabase.auth.getUser(token)`, which re-fetches the live user record
rather than trusting only what was baked into the JWT at sign-in, so no
re-login is required for `GET /api/super-admin/tenants` etc. to start
working. The one place this lags is the **dashboard UI** — the "Platform"
nav link and the `/super-admin` route guard (`AuthContext.tsx`) read the
claim off the locally-cached session, which only updates on that user's
next sign-in or an explicit `refreshSession()`, so ask them to log out and
back in before the link appears. The script requires
`SUPABASE_SERVICE_ROLE_KEY` in `.env`, same as everything else server-side.

## 7. Embedding the chat widget

Every tenant gets a standalone, embeddable chat widget business clients can
paste onto their own website — no login, no build step on their end. The
backend compiles and serves it directly:

- `GET /widget.js` (`src/api/routes/widget.ts`) serves the compiled bundle
  (built from `src/widget/widgetSource.ts` via `npm run build:widget`, which
  the Dockerfile runs automatically at image build time) with
  `Access-Control-Allow-Origin: *` and a short browser cache window, so it
  loads from any third-party origin.
- `POST /api/v1/widget/chat` (`src/api/routes/widgetChat.ts`) is the
  anonymous, tenant-scoped endpoint the widget talks to. It's rate-limited
  per IP (`widgetRateLimiter`) and runs every message through the same
  `processClientMessage` pipeline (and therefore the same guardrails) as
  every other channel — the only thing that makes it "public" is that it
  doesn't require a Supabase session.

Give each business client this snippet, with `YOUR_TENANT_ID` replaced by
their tenant's UUID (visible in their dashboard, or returned from the
`/api/v1/tenants/register` response):

```html
<script src="https://<your-api-host>/widget.js" data-tenant-id="YOUR_TENANT_ID" async></script>
```

For example, once deployed on Render behind `api.costelmedia.online`:

```html
<script src="https://api.costelmedia.online/widget.js" data-tenant-id="YOUR_TENANT_ID" async></script>
```

The `tenantId` is treated like a Stripe *publishable* key — public by
design (anyone viewing page source can see it) and only ever sufficient to
have a scheduling conversation with that one tenant's agent, never to read
or modify anything else. A first-time visitor is asked for a phone number
before chatting (`processClientMessage` uses it as the client-profile key,
the same way SMS/voice/dashboard channels do); returning visitors on the
same browser aren't re-prompted, since the widget remembers it per-tenant
in `localStorage`.

`async` on the tag is required, not cosmetic — the widget captures its own
`<script>` element synchronously at load, before the page around it
necessarily finishes parsing, so it never blocks the host page's render.

To rebuild the widget bundle locally: `npm run build:widget` (outputs to
`public/widget.js`, gitignored as a build artifact — same treatment as
`dist/`).

## 8. Deploying the backend (Render)

`render.yaml` defines the blueprint — a Docker-based web service built from
the repo's multi-stage `Dockerfile`.

1. In the Render dashboard, "New" → "Blueprint", point it at this repo.
   Render reads `render.yaml` and creates the service.
2. Fill in every secret env var listed in `render.yaml` (they're marked
   `sync: false`, meaning Render won't auto-populate them — you set them
   once in the dashboard).
3. Set `ALLOWED_ORIGINS` to your deployed Vercel frontend's origin(s)
   once you know them (chicken-and-egg with step 8 below — it's fine to
   deploy once, note the URLs, then update both).
4. Note the service's public URL — you'll need it for `PUBLIC_WEBHOOK_BASE_URL`
   (if Render's own proxying doesn't already produce the right one — check
   `GET /health` first) and for Twilio's webhook configuration.

**Render free tier + the reminder scheduler:** free web services spin down
after ~15 minutes of no inbound traffic. The reminder cron
(`src/cron/reminderScheduler.ts`) only fires while the process is running,
so on the free plan it effectively pauses during idle periods and catches
up (correctly — the claim-pattern queries are idempotent regardless of
timing) once something wakes the service. An external uptime ping against
`/health` every few minutes keeps it truly real-time; a paid instance
removes the need for that entirely.

## 9. Deploying the frontend (Vercel)

`vercel.json` configures the build (`npm run build`, output directory
`dist/client`) and SPA routing.

1. Import the repo into Vercel.
2. Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and
   `VITE_API_BASE_URL` (the Render backend's URL — required since frontend
   and backend are different origins in this split deployment) as Vercel
   project env vars. These are baked in at **build** time, not read at
   runtime.
3. Deploy. Vercel's default build command/output directory work as-is
   thanks to `vercel.json`.

## 10. Post-deploy checklist

- **Twilio webhooks**: in the Twilio console, point each tenant's phone
  number's messaging webhook at
  `https://<render-host>/api/v1/webhooks/twilio` and its voice webhook at
  `https://<render-host>/api/v1/voice/incoming` (both POST).
- **Google Calendar sharing**: for every tenant, share their Google
  Calendar with the service account's `client_email` ("Make changes to
  events").
- **CORS**: confirm `ALLOWED_ORIGINS` on the Render service matches the
  actual Vercel domain(s) — `src/utils/prodChecklist.ts` logs a critical
  warning (and exits nonzero when `NODE_ENV=production`) if this is still
  unset or wildcarded.
- **Secrets strength**: the same checklist runs a real entropy check on
  `GROQ_API_KEY`/`SUPABASE_SERVICE_ROLE_KEY`/etc. at boot and logs which
  ones look like placeholders — check the boot logs after first deploy.
- **`GET /health`**: hit it once deployed; it independently reports Groq,
  Supabase, and Google Calendar connectivity so you can see at a glance
  what's configured and what isn't.
- **`GET /widget.js`**: confirm it returns `200` with
  `Access-Control-Allow-Origin: *` (a `503` means the Docker build stage's
  `npm run build:widget` step didn't run or didn't produce
  `public/widget.js` — see section 7).

## 11. Troubleshooting

- **"Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"** — the most
  common failure for any script or route touching the database; confirm
  the env var is actually in the process's environment (not just in
  `.env.example`).
- **Seed script says a user/tenant already exists** — that's expected on a
  second run; it reuses them. Use `npm run seed:reset` to start clean.
- **Dashboard shows 401s immediately after deploy** — check
  `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` were actually set at Vercel
  **build** time (a runtime-only env var won't reach the bundle).
- **Twilio signature verification failing** — usually `PUBLIC_WEBHOOK_BASE_URL`
  needs to be set explicitly if a proxy in front of Render changes the
  host/protocol Express sees; compare against exactly what you configured
  in the Twilio console.
