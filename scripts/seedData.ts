#!/usr/bin/env -S node --experimental-strip-types
/**
 * Seeds a demo tenant ("Metro Dental Clinic"), an admin user, 5 client
 * profiles (formality scores 1–5), and 10 sample appointments (7
 * confirmed, 3 cancelled) — for local development and manual testing
 * against a real Supabase project. Safe to re-run: reuses the existing
 * admin user/tenant if found, rather than erroring or duplicating them.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types scripts/seedData.ts
 *   node --env-file=.env --experimental-strip-types scripts/seedData.ts --reset
 *
 * `--reset` deletes the existing demo tenant (which cascades to its
 * client_profiles/appointments/conversation_logs/etc. via FK) and the
 * admin user, then recreates both fresh.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
 * (see .env.example) — nothing else. It never touches Groq, Google
 * Calendar, or Twilio: appointments are inserted directly with
 * `googleEventId: null`, so this works with zero external setup beyond
 * Supabase itself.
 *
 * Not `ts-node`, despite that being the conventional choice for a
 * standalone TS script: ts-node 10.x's ESM loader is incompatible with
 * Node 22's newer loader hooks API (`ERR_UNKNOWN_FILE_EXTENSION` on every
 * `.ts` import) — a known, unresolved upstream issue, confirmed
 * empirically against this exact project setup, not a configuration gap
 * on this repo's end. Node's own `--experimental-strip-types` needs no
 * extra dependency, but — also confirmed empirically, contrary to what
 * you'd expect — it does *not* remap a `.js` specifier to a sibling `.ts`
 * file the way tsc's `nodenext` resolution does; it only resolves the
 * literal path given. That's why the imports below use `.ts` extensions
 * directly rather than this repo's usual `nodenext`-style `.js` — this
 * script is never compiled by `tsc` (only type-checked, via
 * tsconfig.scripts.json's `noEmit`), so it's free to use whichever
 * specifier form its own execution method actually needs.
 */
import {
  createAuthUser,
  deleteAuthUser,
  deleteTenant,
  getAuthUserByEmail,
  getOrCreateClientProfile,
  getTenantByOwnerUserId,
  insertAppointment,
  insertTenant,
  updateClientName,
  updateClientToneProfile,
} from "../src/db/supabase.ts";
import type { Appointment, AppointmentStatus, BookingChannel, ClientProfile, FiveScale } from "../src/types/index.ts";

const ADMIN_EMAIL = "admin@metrodental.com";
const ADMIN_PASSWORD = "Password123!";
const TENANT_NAME = "Metro Dental Clinic";
const TENANT_TIMEZONE = "America/New_York";
const PLACEHOLDER_CALENDAR_ID = "metro-dental-demo@group.calendar.google.com";
const GOOGLE_CALENDAR_ID = process.env["SEED_GOOGLE_CALENDAR_ID"] ?? PLACEHOLDER_CALENDAR_ID;

const shouldReset = process.argv.includes("--reset");

function log(message: string): void {
  console.log(`[seed] ${message}`);
}

// ---------------------------------------------------------------------------
// Client profiles
// ---------------------------------------------------------------------------

interface SeedClientSpec {
  phoneNumber: string;
  fullName: string;
  formalityScore: FiveScale;
  communicationStyle: string;
  notes: string;
}

const CLIENT_SPECS: readonly SeedClientSpec[] = [
  {
    phoneNumber: "+15555550101",
    fullName: "Jamie Rivera",
    formalityScore: 1,
    communicationStyle: "relaxed and casual",
    notes: "Prefers short, casual texts — no need for formalities.",
  },
  {
    phoneNumber: "+15555550102",
    fullName: "Alex Chen",
    formalityScore: 2,
    communicationStyle: "casual but urgent",
    notes: "Usually messages last-minute about tight scheduling windows.",
  },
  {
    phoneNumber: "+15555550103",
    fullName: "Morgan Blake",
    formalityScore: 3,
    communicationStyle: "friendly and neutral",
    notes: "Straightforward; no particular preferences noted yet.",
  },
  {
    phoneNumber: "+15555550104",
    fullName: "Dr. Patricia Nguyen",
    formalityScore: 4,
    communicationStyle: "formal and measured",
    notes: "Referring physician's office coordinates on her behalf — keep replies professional.",
  },
  {
    phoneNumber: "+15555550105",
    fullName: "Robert Ashford",
    formalityScore: 5,
    communicationStyle: "formal and urgent",
    notes: "Expects prompt, formal correspondence; dislikes being kept waiting.",
  },
] as const;

async function seedClientProfiles(tenantId: string): Promise<ClientProfile[]> {
  const clients: ClientProfile[] = [];
  for (const spec of CLIENT_SPECS) {
    const profile = await getOrCreateClientProfile(tenantId, spec.phoneNumber);
    await updateClientName(tenantId, profile.id, spec.fullName);
    const updated = await updateClientToneProfile(tenantId, profile.id, {
      formalityScore: spec.formalityScore,
      communicationStyle: spec.communicationStyle,
      notes: spec.notes,
    });
    clients.push(updated);
    log(`  Client: ${spec.fullName} (formality ${spec.formalityScore}/5)`);
  }
  return clients;
}

// ---------------------------------------------------------------------------
// Appointments — 7 confirmed, 3 cancelled, spanning past and upcoming dates
// so analytics (cancellation rate, peak hours, daily stats) has something
// real to aggregate over.
// ---------------------------------------------------------------------------

interface SeedAppointmentSpec {
  /** Days from today; negative = already happened. */
  dayOffset: number;
  hour: number;
  serviceType: string;
  status: AppointmentStatus;
  bookingChannel: BookingChannel;
}

const APPOINTMENT_SPECS: readonly SeedAppointmentSpec[] = [
  { dayOffset: -14, hour: 9, serviceType: "Dental Checkup", status: "confirmed", bookingChannel: "ai_chat" },
  { dayOffset: -10, hour: 11, serviceType: "Teeth Cleaning", status: "confirmed", bookingChannel: "ai_voice" },
  { dayOffset: -7, hour: 14, serviceType: "Cavity Filling", status: "cancelled", bookingChannel: "ai_chat" },
  { dayOffset: -5, hour: 10, serviceType: "Consultation", status: "confirmed", bookingChannel: "staff_manual" },
  { dayOffset: -2, hour: 15, serviceType: "Root Canal", status: "confirmed", bookingChannel: "ai_chat" },
  { dayOffset: -1, hour: 13, serviceType: "Whitening Treatment", status: "cancelled", bookingChannel: "ai_voice" },
  { dayOffset: 1, hour: 9, serviceType: "Follow-up Visit", status: "confirmed", bookingChannel: "ai_chat" },
  { dayOffset: 3, hour: 16, serviceType: "Braces Adjustment", status: "confirmed", bookingChannel: "ai_chat" },
  { dayOffset: 7, hour: 11, serviceType: "Wisdom Tooth Extraction", status: "confirmed", bookingChannel: "staff_manual" },
  { dayOffset: 14, hour: 10, serviceType: "Emergency Visit", status: "cancelled", bookingChannel: "ai_voice" },
] as const;

const APPOINTMENT_DURATION_MINUTES = 30;

function dateAtHour(dayOffset: number, hour: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, 0, 0, 0);
  return date;
}

async function seedAppointments(tenantId: string, clients: ClientProfile[]): Promise<Appointment[]> {
  const appointments: Appointment[] = [];
  for (const [index, spec] of APPOINTMENT_SPECS.entries()) {
    const client = clients[index % clients.length];
    if (!client) {
      continue; // Unreachable in practice (clients always has 5 entries) — keeps noUncheckedIndexedAccess honest.
    }

    const startTime = dateAtHour(spec.dayOffset, spec.hour);
    const endTime = new Date(startTime.getTime() + APPOINTMENT_DURATION_MINUTES * 60 * 1000);

    const appointment = await insertAppointment({
      tenantId,
      clientId: client.id,
      googleEventId: null, // DB-only seed record — not mirrored to any real calendar.
      serviceType: spec.serviceType,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      status: spec.status,
      bookingChannel: spec.bookingChannel,
    });
    appointments.push(appointment);
    log(`  Appointment: ${spec.serviceType} for ${client.fullName ?? client.phoneNumber} on ${startTime.toDateString()} (${spec.status})`);
  }
  return appointments;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`Starting${shouldReset ? " (--reset)" : ""}...`);

  const existingAdmin = await getAuthUserByEmail(ADMIN_EMAIL);
  let adminUserId: string;

  if (shouldReset && existingAdmin) {
    const existingTenant = await getTenantByOwnerUserId(existingAdmin.id);
    if (existingTenant) {
      await deleteTenant(existingTenant.id);
      log(`Deleted existing tenant "${existingTenant.name}" (${existingTenant.id}) and all its data.`);
    }
    await deleteAuthUser(existingAdmin.id);
    log(`Deleted existing admin user ${ADMIN_EMAIL}.`);
    const recreated = await createAuthUser(ADMIN_EMAIL, ADMIN_PASSWORD);
    adminUserId = recreated.id;
    log(`Created admin user ${ADMIN_EMAIL} (${adminUserId}).`);
  } else if (existingAdmin) {
    adminUserId = existingAdmin.id;
    log(`Reusing existing admin user ${ADMIN_EMAIL} (${adminUserId}).`);
  } else {
    const created = await createAuthUser(ADMIN_EMAIL, ADMIN_PASSWORD);
    adminUserId = created.id;
    log(`Created admin user ${ADMIN_EMAIL} (${adminUserId}).`);
  }

  let tenant = await getTenantByOwnerUserId(adminUserId);
  if (tenant) {
    log(`Reusing existing tenant "${tenant.name}" (${tenant.id}).`);
  } else {
    tenant = await insertTenant({
      ownerUserId: adminUserId,
      name: TENANT_NAME,
      businessType: "clinic",
      googleCalendarId: GOOGLE_CALENDAR_ID,
      timezone: TENANT_TIMEZONE,
    });
    log(`Created tenant "${tenant.name}" (${tenant.id}).`);
    if (GOOGLE_CALENDAR_ID === PLACEHOLDER_CALENDAR_ID) {
      log("  ⚠ Using a placeholder Google Calendar ID — real bookings need a calendar shared with your service account.");
      log("    Set SEED_GOOGLE_CALENDAR_ID to override, or update the tenant's google_calendar_id later.");
    }
  }

  log("Seeding client profiles...");
  const clients = await seedClientProfiles(tenant.id);

  log("Seeding appointments...");
  const appointments = await seedAppointments(tenant.id, clients);

  log("");
  log("Done.");
  log(`  Tenant:       ${tenant.name} (${tenant.id})`);
  log(`  Admin login:  ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  log(`  Clients:      ${clients.length}`);
  log(`  Appointments: ${appointments.length}`);
}

main().catch((error: unknown) => {
  console.error("[seed] FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
