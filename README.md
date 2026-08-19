# AI Booking Platform (CostelMedia)

Multi-tenant AI voice/chat scheduling SaaS — an Express + TypeScript API
(Groq LLM, ElevenLabs TTS, Deepgram STT, Twilio voice/SMS, Google Calendar)
backed by Supabase (Postgres + Auth), with a Vite/React admin dashboard.
Live at [costelmedia.online](https://costelmedia.online) (frontend on
Vercel, API on Render at `api.costelmedia.online`).

For full setup — Supabase project creation, running migrations, every
environment variable, local dev, seeding, and production deployment — see
**[DEPLOYMENT.md](DEPLOYMENT.md)**. This file covers the two things people
usually land here looking for: getting the app running locally, and the
auth/roles model.

## Quickstart (local dev)

```bash
npm install
cp .env.example .env   # fill in at minimum SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
                        # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, GROQ_API_KEY
npm run dev:all         # Vite dev server (5173) + API (8787), concurrently
```

Run every file in `supabase/migrations/` against your Supabase project
first, in filename order — see [DEPLOYMENT.md §2](DEPLOYMENT.md#2-supabase-setup).

## Auth & roles

Two account types, both backed by the same `auth.users` table but kept
strictly separate in what they can do:

| | `TENANT_ADMIN` | `SUPER_ADMIN` |
|---|---|---|
| Scope | One tenant (their own business) | Every tenant on the platform |
| Assigned | Automatically, on registration | Manually, via the promotion script below |
| Sign-up | `/register` — email/password or Google | Not self-serve — promoted from an existing account |
| Enforced by | Postgres RLS (`current_tenant_id()`), plus Express/frontend checks | Postgres RLS (`is_super_admin()`), plus `requireSuperAdmin` middleware and `/super-admin` route guard |

**Registering a new business** (`/register`): email/password creates the
Supabase Auth user and the `tenants` row together in one call, and signs
the new admin straight in. "Sign up with Google" instead authenticates via
OAuth and lands on `/onboarding` to collect the business name/type
separately, since Google's OAuth flow has no request body to attach that
to at consent time. Either path ends the same way: a `tenants` row owned
by that user, and a database trigger that assigns them `tenant_admin` for
it — no manual role-assignment step, ever.

**Tenant isolation**: every table's Row Level Security policy filters by
`tenant_id` read from the caller's JWT. Tenant A's admin cannot query
Tenant B's appointments, call logs, FAQs, or settings — not because the
application code remembers to filter, but because the database rejects
the query regardless of what the API layer does. This is enforced
identically whether the request comes from the dashboard, a direct API
call, or a bug in this app's own code.

**Promoting an account to `SUPER_ADMIN`** — e.g. your own account, to
manage the platform:

```bash
npm run promote:super-admin -- you@example.com
```

The API grants access immediately (`GET /api/super-admin/tenants`, etc.) —
only the dashboard's own "Platform" nav link and `/super-admin` route
guard need that account to sign out and back in first, since those read
the claim off the locally-cached browser session rather than asking the
server fresh. See [DEPLOYMENT.md §6a](DEPLOYMENT.md#6a-roles--super-admin)
for exactly how this is enforced end to end.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev:all` | Vite dev server + API, concurrently |
| `npm run build` / `npm run build:server` | Production frontend / backend build |
| `npm run typecheck` / `typecheck:web` / `typecheck:test` / `typecheck:scripts` | TypeScript, per project (backend / frontend / tests / scripts) |
| `npm run lint` | ESLint |
| `npm run test` | Vitest |
| `npm run seed` | Seed demo tenant data (`--reset` to wipe first) |
| `npm run promote:super-admin -- <email>` | Grant `SUPER_ADMIN` to an existing account |

## License

ISC
