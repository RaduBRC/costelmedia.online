/**
 * Unit tests for src/agent/promptBuilder.ts's two dynamic-per-tenant
 * surfaces — getVoiceGreeting and buildSystemPrompt's adaptive booking-
 * field instructions — across every BusinessType. Both are pure functions
 * (no Groq/Supabase/network involved), so this is direct unit coverage
 * rather than the full orchestration Scenario A–C in
 * agentBookingFlow.test.ts already exercise.
 *
 * The specific thing under test: no niche's prompt/greeting is a canned,
 * hardcoded string sharing state across tenants (e.g. the old
 * "clinica noastră" greeting every business type used to get regardless
 * of its actual name/industry) — every tenant's own name and business
 * type must actually appear, and no *other* niche's fields/wording may
 * leak into a tenant that isn't that niche.
 */
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, getVoiceGreeting } from "../src/agent/promptBuilder.js";
import type { BusinessType, Tenant } from "../src/types/index.js";

const BASE_TENANT: Tenant = {
  id: "00000000-0000-0000-0000-000000000000",
  ownerUserId: "11111111-1111-1111-1111-111111111111",
  name: "Placeholder",
  businessType: "general_services",
  googleCalendarId: "placeholder@example.com",
  timezone: "Europe/Bucharest",
  workingHours: {
    monday: { start: "09:00", end: "17:00" },
    tuesday: { start: "09:00", end: "17:00" },
    wednesday: { start: "09:00", end: "17:00" },
    thursday: { start: "09:00", end: "17:00" },
    friday: { start: "09:00", end: "17:00" },
    saturday: null,
    sunday: null,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  elevenlabsVoiceId: null,
  systemPromptOverride: null,
  greetingMessage: null,
  isActive: true,
  publicPhoneNumber: null,
  address: null,
  toneOfVoice: "friendly",
};

function tenantFor(businessType: BusinessType, name: string, overrides: Partial<Tenant> = {}): Tenant {
  return { ...BASE_TENANT, businessType, name, ...overrides };
}

// ---------------------------------------------------------------------------
// getVoiceGreeting — every niche gets ITS OWN name/industry substituted in,
// never a shared canned phrase.
// ---------------------------------------------------------------------------

describe("getVoiceGreeting", () => {
  it("builds the default greeting from the tenant's own name and industry, for every business type", () => {
    const cases: { businessType: BusinessType; name: string; expectedLabel: string }[] = [
      { businessType: "clinic", name: "Metro Dental Clinic", expectedLabel: "programări medicale" },
      { businessType: "restaurant", name: "Trattoria Bella", expectedLabel: "rezervări" },
      { businessType: "callcenter", name: "Helpline Pro", expectedLabel: "suport clienți" },
      { businessType: "auto_shop", name: "Auto Doc Service", expectedLabel: "reparații auto" },
      { businessType: "salon", name: "Glow Beauty Salon", expectedLabel: "înfrumusețare" },
      { businessType: "legal_services", name: "Ionescu & Partners", expectedLabel: "consultanță juridică" },
      { businessType: "general_services", name: "Acme Services", expectedLabel: "programări" },
    ];

    for (const { businessType, name, expectedLabel } of cases) {
      const greeting = getVoiceGreeting(tenantFor(businessType, name));
      expect(greeting).toContain(name);
      expect(greeting).toContain(expectedLabel);
      // No leftover template syntax, and no other niche's tenant name
      // leaking in from a shared/static string.
      expect(greeting).not.toContain("{company_name}");
      expect(greeting).not.toContain("{business_type}");
    }
  });

  it("never falls back to a hardcoded competitor's/generic canned phrase like the old clinic-only greeting", () => {
    const autoShop = getVoiceGreeting(tenantFor("auto_shop", "Auto Doc Service"));
    const salon = getVoiceGreeting(tenantFor("salon", "Glow Beauty Salon"));
    // The two must differ (dynamic per tenant) and neither may contain
    // wording specific to a different vertical.
    expect(autoShop).not.toBe(salon);
    expect(autoShop.toLowerCase()).not.toContain("clinica");
    expect(salon.toLowerCase()).not.toContain("clinica");
  });

  it("prefers the tenant's own custom greetingMessage, substituting both placeholders", () => {
    const tenant = tenantFor("auto_shop", "Auto Doc Service", {
      greetingMessage: "Salut, ai apelat {company_name} — {business_type}. Spune-mi cu ce te ajut.",
    });
    expect(getVoiceGreeting(tenant)).toBe("Salut, ai apelat Auto Doc Service — reparații auto. Spune-mi cu ce te ajut.");
  });

  it("falls back to the dynamic default when greetingMessage is blank/whitespace-only", () => {
    const tenant = tenantFor("clinic", "Metro Dental Clinic", { greetingMessage: "   " });
    expect(getVoiceGreeting(tenant)).toContain("Metro Dental Clinic");
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt — adaptive required-booking-field instructions, one
// per niche, and constrained to ONLY that niche's own fields.
// ---------------------------------------------------------------------------

describe("buildSystemPrompt adaptive booking fields", () => {
  it("auto_shop: asks for make/model and issue description, not call-center or clinic fields", () => {
    const prompt = buildSystemPrompt(tenantFor("auto_shop", "Auto Doc Service"));
    expect(prompt).toContain("vehicle's make and model");
    expect(prompt).toContain("description of the issue");
    expect(prompt).not.toContain("Urgency level");
    expect(prompt).not.toContain("Preferred practitioner");
  });

  it("callcenter: asks for issue description, urgency, and a callback number, not vehicle/clinic fields", () => {
    const prompt = buildSystemPrompt(tenantFor("callcenter", "Helpline Pro"));
    expect(prompt).toContain("description of the issue or request");
    expect(prompt).toContain("Urgency level");
    expect(prompt).toContain("callback phone number");
    expect(prompt).not.toContain("vehicle's make and model");
    expect(prompt).not.toContain("Preferred practitioner");
  });

  it("clinic: asks for service type and preferred practitioner, not vehicle/urgency fields", () => {
    const prompt = buildSystemPrompt(tenantFor("clinic", "Metro Dental Clinic"));
    expect(prompt).toContain("type of service/appointment needed");
    expect(prompt).toContain("Preferred practitioner");
    expect(prompt).not.toContain("vehicle's make and model");
    expect(prompt).not.toContain("callback phone number");
  });

  it("salon: asks for service type and preferred stylist/technician", () => {
    const prompt = buildSystemPrompt(tenantFor("salon", "Glow Beauty Salon"));
    expect(prompt).toContain("type of service needed");
    expect(prompt).toContain("Preferred stylist/technician");
  });

  it("every niche's field list still requires date/time and the client's name and phone", () => {
    const businessTypes: BusinessType[] = ["auto_shop", "callcenter", "clinic", "salon", "legal_services", "restaurant", "general_services"];
    for (const businessType of businessTypes) {
      const prompt = buildSystemPrompt(tenantFor(businessType, "Test Tenant"));
      expect(prompt).toContain("Preferred date and time");
      expect(prompt).toContain("The client's name and a phone number");
      // The explicit "don't collect more than this" boundary is present
      // for every vertical, not just some of them.
      expect(prompt).toContain("Do not ask for anything outside this list");
    }
  });

  it("injects the tenant's own name and industry into the identity line for every business type", () => {
    const cases: { businessType: BusinessType; name: string }[] = [
      { businessType: "auto_shop", name: "Auto Doc Service" },
      { businessType: "callcenter", name: "Helpline Pro" },
      { businessType: "clinic", name: "Metro Dental Clinic" },
      { businessType: "salon", name: "Glow Beauty Salon" },
      { businessType: "legal_services", name: "Ionescu & Partners" },
    ];
    for (const { businessType, name } of cases) {
      const prompt = buildSystemPrompt(tenantFor(businessType, name));
      expect(prompt).toContain(`scheduling assistant for ${name}`);
    }
  });
});
