/**
 * Builds the system prompt handed to Groq for each turn: tenant-specific
 * conversational rules plus whatever we already know about this client's
 * communication preferences.
 */
import type { BookingChannel, BusinessType, ClientProfile, Faq, Service, Tenant, ToneAssessment, ToneOfVoice } from "../types/index.js";

/**
 * One tailored rule block per vertical — this Record<BusinessType, string>
 * is itself what makes cross-vertical contamination structurally
 * impossible: buildSystemPrompt only ever injects
 * BUSINESS_TYPE_RULES[tenant.businessType], a single lookup, never a
 * blend of several. A "legal_services" tenant's prompt physically cannot
 * contain the clinic block's medical-disclaimer language, because that
 * string is never read for anything but businessType === "clinic". The
 * explicit reinforcement line in buildSystemPrompt's identity block below
 * is a second, LLM-facing layer on top of that — belt and suspenders, not
 * the only thing preventing it.
 */
/**
 * Persona/tone/safety guidance only — deliberately does NOT list which
 * fields to collect before booking anymore (e.g. "get the make/model
 * before booking"). That's now REQUIRED_BOOKING_INFO + formatRequiredBookingInfo
 * below, kept as a single, explicit, auditable source of truth per
 * vertical instead of being duplicated (and able to drift out of sync)
 * across two different blocks of the prompt.
 */
const BUSINESS_TYPE_RULES: Record<BusinessType, string> = {
  clinic:
    "This is a medical clinic. Use a calm, compassionate, and reassuring tone — patients may be " +
    "anxious or in discomfort. Never diagnose, give medical advice, or promise a specific provider.",
  restaurant:
    "This is a restaurant. Keep responses quick, warm, and structured, in a short, scannable format. " +
    "Avoid long paragraphs; diners are often messaging on the go.",
  callcenter:
    "This is a call center handling scheduling requests at volume. Be efficient and professional: get to " +
    "the point, avoid filler, and structure replies so the client can act on them immediately.",
  auto_shop:
    "This is an auto repair shop. Never estimate a repair cost or diagnose a mechanical problem yourself " +
    "— that's the mechanic's job once the vehicle is seen. Confirm drop-off vs. wait-on-site expectations " +
    "if the client doesn't specify.",
  salon:
    "This is a hair/beauty salon. Services often have different durations — always call " +
    "check_available_slots with the client's actual chosen service rather than assuming a default length.",
  legal_services:
    "This is a professional services / legal practice booking client consultations. Keep the tone " +
    "professional and discreet — clients may be discussing sensitive matters; never give legal advice, " +
    "opinions on a case's merits, or any information that could be construed as counsel yourself — that's " +
    "strictly the attorney's role once the consultation happens.",
  general_services:
    "This is a general-purpose service business without a more specific vertical configured. Stay " +
    "flexible and don't assume any industry-specific context (no medical, legal, automotive, or culinary " +
    "framing) unless the client's own words introduce it.",
};

/**
 * The vertical-specific information that actually needs collecting in
 * conversation before create_appointment gets called — see
 * formatRequiredBookingInfo below for how this turns into a hard
 * "collect exactly this, nothing more" instruction. Every vertical also
 * needs a date/time and the client's name + a phone number regardless —
 * those are create_appointment's own required parameters (groqAgent.ts)
 * and are appended once in formatRequiredBookingInfo rather than repeated
 * in every row here.
 */
const REQUIRED_BOOKING_INFO: Record<BusinessType, string[]> = {
  auto_shop: ["The vehicle's make and model", "A description of the issue"],
  callcenter: ["A description of the issue or request", "Urgency level (routine vs. urgent)", "A callback phone number"],
  clinic: ["The type of service/appointment needed", "Preferred practitioner, if the client has one"],
  salon: ["The type of service needed", "Preferred stylist/technician, if the client has one"],
  legal_services: ["The general topic or reason for the consultation (never the case details themselves)"],
  restaurant: ["Party size", "Any special requests (dietary, seating, occasion)"],
  general_services: ["The specific service needed"],
};

/**
 * Renders REQUIRED_BOOKING_INFO[businessType] plus the two universal
 * fields (date/time, name + phone) as a hard collection checklist, with
 * an explicit "nothing more than this" boundary — directly enforces "only
 * collect what this niche's booking actually needs" rather than leaving
 * the model to infer it from BUSINESS_TYPE_RULES' looser tone guidance.
 */
function formatRequiredBookingInfo(businessType: BusinessType): string {
  const fields = [...REQUIRED_BOOKING_INFO[businessType], "Preferred date and time", "The client's name and a phone number"];
  return (
    "Before calling create_appointment, collect exactly this information for this business — no more, no " +
    `fewer:\n${fields.map((field) => `- ${field}`).join("\n")}\n` +
    "Do not ask for anything outside this list (insurance details, payment information, full home address, " +
    "vehicle VIN, etc.) unless the client volunteers it unprompted — asking for more than a booking " +
    "actually needs slows the client down and isn't this business's job at this stage."
  );
}

const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  clinic: "medical clinic",
  restaurant: "restaurant",
  callcenter: "call center",
  auto_shop: "auto repair shop",
  salon: "hair/beauty salon",
  legal_services: "professional services / legal practice",
  general_services: "service business",
};

// ---------------------------------------------------------------------------
// Voice-call greeting and manners
//
// Scoped to channel === "ai_voice" only — these are Romanian-language,
// spoken-call-specific instructions, and would be wrong to inject into
// SMS/WhatsApp/dashboard-chat/widget conversations, which may well be in
// a different language and are read, not heard.
// ---------------------------------------------------------------------------

/**
 * Romanian noun phrase for "serviciul de {business_type}" in the default
 * greeting template below — deliberately a natural service-noun, not the
 * raw BusinessType enum value or its English label, so the generated
 * sentence reads correctly in Romanian (e.g. "serviciul de programări
 * medicale", not "serviciul de clinic").
 */
const BUSINESS_TYPE_LABELS_RO: Record<BusinessType, string> = {
  clinic: "programări medicale",
  restaurant: "rezervări",
  callcenter: "suport clienți",
  auto_shop: "reparații auto",
  salon: "înfrumusețare",
  legal_services: "consultanță juridică",
  general_services: "programări",
};

/**
 * The fixed opening line spoken automatically the moment a voice call
 * connects — before the caller says anything. Deliberately NOT generated
 * by Groq: a scripted, guaranteed-wording greeting (played directly via
 * TTS — see voiceStreamServer.ts's "start" handler) is more reliable than
 * asking the model to reproduce exact phrasing every time, and skips a
 * Groq round-trip on the one turn where the content never varies anyway.
 *
 * `tenant.greetingMessage`, if set, wins over the dynamic default —
 * supports literal "{company_name}" and "{business_type}" placeholders
 * (substituted the same way the default template below builds itself) so
 * a tenant can customize wording without retyping their own name/industry
 * into it.
 *
 * With no custom greeting configured, every tenant gets a greeting built
 * from ITS OWN name and industry — there is no shared, hardcoded business
 * name or vertical-specific canned phrase (e.g. "clinica noastră") baked
 * in anywhere here; a clinic, a salon, and a call center all go through
 * this exact same template, just with different tenant/label values
 * substituted in.
 */
export function getVoiceGreeting(tenant: Tenant): string {
  const template = tenant.greetingMessage?.trim() || DEFAULT_GREETING_TEMPLATE;
  return template.replaceAll("{company_name}", tenant.name).replaceAll("{business_type}", BUSINESS_TYPE_LABELS_RO[tenant.businessType]);
}

const DEFAULT_GREETING_TEMPLATE = "Bună ziua, ați sunat la {company_name}, serviciul de {business_type}. Cu ce vă pot ajuta?";

const VOICE_MANNERS_BLOCK =
  "This conversation is a live phone call, conducted entirely in Romanian. The caller has already " +
  "been greeted automatically when the call connected — don't greet them again; respond directly to " +
  "what they say. Follow these voice-specific manners:\n" +
  '- Use polite Romanian phrasing naturally throughout — "vă rog", "cu drag", "vă ajut cu plăcere", ' +
  '"mulțumesc" — without overusing any single one; it should sound like a courteous person, not a ' +
  "script.\n" +
  "- Before finalizing any booking, ALWAYS read the details back and ask for confirmation in one turn, " +
  'then wait for the caller\'s reply — e.g. "Ați dori o programare pe data de [dată] la ora [oră]. ' +
  'Este corect?" This applies even when the caller already stated every detail (date, time, service, ' +
  "name) unprompted in a single message — do not call create_appointment in that same turn just " +
  "because nothing is ambiguous. Only call create_appointment on the turn after the caller has " +
  "explicitly confirmed (\"da\", \"corect\", \"exact\", or similar).\n" +
  "- If the audio was unclear or you didn't catch something, say so plainly and ask them to repeat — " +
  'e.g. "Nu am înțeles exact, puteți repeta vă rog?" — never guess at or invent what they might have ' +
  "said.\n" +
  "- Keep every response short and natural, the way a person actually talks on the phone — one or two " +
  "sentences per turn. A caller can't skim spoken audio the way they can skim text, so long, " +
  "paragraph-style answers read as robotic and are hard to follow out loud.";

/** en-CA formats as YYYY-MM-DD, matching check_available_slots's expected date format — a convenient locale choice, not a real-world "Canadian" concern. */
function getTodayInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  } catch {
    // Unknown/invalid IANA timezone string — fall back to UTC rather than throw; a
    // slightly-off "today" is far better than the system prompt failing to build at all.
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date());
  }
}

function describeFormality(score: ClientProfile["formalityScore"]): string {
  if (score >= 4) {
    return `Formality level ${score}/5 — use polished, professional language; avoid slang and emoji.`;
  }
  if (score <= 2) {
    return `Formality level ${score}/5 — keep it casual and conversational.`;
  }
  return `Formality level ${score}/5 — a neutral, friendly professional tone.`;
}

function describeClientTraits(clientProfile: ClientProfile): string[] {
  const traits: string[] = [describeFormality(clientProfile.formalityScore)];

  if (clientProfile.communicationStyle) {
    traits.push(`Preferred communication style: ${clientProfile.communicationStyle}.`);
  }
  if (clientProfile.notes) {
    traits.push(`Notes from previous interactions: ${clientProfile.notes}`);
  }
  if (clientProfile.fullName) {
    traits.push(`The client's name is ${clientProfile.fullName}; use it naturally, don't overuse it.`);
  }

  return traits;
}

/**
 * Urgency/sentiment guidance for *this specific message* — unlike
 * formality (persisted to the client's profile as a lasting preference),
 * urgency is read fresh every turn and isn't stored, since "urgent right
 * now" isn't a durable trait to remember about someone.
 */
function describeCurrentTone(currentTone: ToneAssessment): string[] {
  const lines: string[] = [];

  if (currentTone.urgency >= 4) {
    lines.push(
      "This message reads as urgent. Drop pleasantries and small talk — be ultra-direct and concise, " +
        "confirm the essential details in as few exchanges as possible, and move straight to booking or " +
        "resolving the request.",
    );
  }
  if (currentTone.sentiment === "frustrated" || currentTone.sentiment === "negative") {
    lines.push(
      "The client sounds frustrated. Briefly acknowledge that once, without being obsequious, then focus " +
        "entirely on resolving the request — don't dwell on the apology.",
    );
  }

  return lines;
}

/**
 * Builds the full system prompt for a conversation turn: fixed tenant
 * rules, this message's live tone read, plus (if known) this client's
 * learned communication traits. `channel` additionally appends
 * voice-call-specific manners (Romanian phrasing, confirm-before-booking,
 * ask-to-repeat-if-unclear) when it's "ai_voice" — see VOICE_MANNERS_BLOCK
 * above for why that's channel-gated rather than global.
 */
function withIndefiniteArticle(label: string): string {
  return /^[aeiou]/i.test(label) ? `an ${label}` : `a ${label}`;
}

/**
 * Formats the tenant's active services (supabase/migrations/015_services_catalog.sql)
 * as a plain list the model can quote prices/durations from, without
 * inventing them — check_available_slots/create_appointment still take a
 * free-text service_type (appointments.service_type stays exactly as it
 * was, see the migration's own header comment), so this is informational
 * grounding, not a new tool contract.
 */
function formatActiveServicesList(services: Service[]): string {
  if (services.length === 0) {
    return "No services are configured yet for this business — ask the client what they need and proceed without quoting a price or fixed duration.";
  }
  const lines = services.map((service) => {
    const price = (service.priceMinorUnits / 100).toFixed(2);
    return `- ${service.name}: ${service.durationMinutes} min, ${price} ${service.currency}${service.description ? ` — ${service.description}` : ""}`;
  });
  return (
    "Services offered, with their real duration and price — quote these exactly, never estimate or invent " +
    `a price/duration for a service not listed here:\n${lines.join("\n")}`
  );
}

const WEEKDAY_LABELS: Record<keyof Tenant["workingHours"], string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

/**
 * Renders tenant.workingHours as plain, readable text — so the model can
 * answer "what are your hours?" or "are you open Sundays?" directly,
 * without needing to call check_available_slots just to find out. That
 * tool still stays the sole source of truth for whether a *specific*
 * slot is actually free (this is hours only, not availability); the
 * "never invent availability" instruction elsewhere still applies.
 */
function formatWorkingHours(tenant: Tenant): string {
  const lines = (Object.keys(WEEKDAY_LABELS) as (keyof Tenant["workingHours"])[]).map((day) => {
    const hours = tenant.workingHours[day];
    return `- ${WEEKDAY_LABELS[day]}: ${hours ? `${hours.start}–${hours.end}` : "Closed"}`;
  });
  return `Business hours (${tenant.timezone}):\n${lines.join("\n")}`;
}

const TONE_OF_VOICE_INSTRUCTIONS: Record<ToneOfVoice, string> = {
  formal: "This business has set a formal brand voice: polished, professional language throughout, no slang, no emoji, minimal contractions.",
  friendly: "This business has set a friendly brand voice: warm and conversational, contractions are fine, a light emoji is fine if it fits naturally — still competent and clear, not silly.",
};

/**
 * The tenant's fixed brand-voice choice (tenants.tone_of_voice) — distinct
 * from describeClientTraits' per-client formality (a learned trait about
 * *this specific caller*) and describeCurrentTone's per-message read (how
 * *this message* reads right now). All three can coexist and even pull in
 * different directions (a "friendly" business replying to a very formal
 * client, say) — the model is expected to blend them, same as a real
 * receptionist would.
 */
function describeToneOfVoice(tone: ToneOfVoice): string {
  return TONE_OF_VOICE_INSTRUCTIONS[tone];
}

/**
 * Formats the tenant's active FAQs (019_tenant_tone_and_faqs.sql) so the
 * model can answer common questions directly and consistently instead of
 * improvising an answer that might drift from what the business actually
 * wants said. Omitted entirely (not even a "no FAQs configured" line) when
 * empty — unlike services, an empty FAQ list isn't something the model
 * needs to be told to compensate for, it just has nothing extra to draw on.
 */
function formatFaqs(faqs: Faq[]): string | null {
  if (faqs.length === 0) {
    return null;
  }
  const lines = faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`);
  return (
    "Frequently asked questions for this business — use these exact answers when a client asks something " +
    `matching one of these, rather than improvising:\n${lines.join("\n\n")}`
  );
}

export function buildSystemPrompt(
  tenant: Tenant,
  clientProfile?: ClientProfile,
  currentTone?: ToneAssessment,
  channel?: BookingChannel,
  activeServices?: Service[],
  faqs?: Faq[],
): string {
  const lines: string[] = [
    `You are the scheduling assistant for ${tenant.name}, ${withIndefiniteArticle(BUSINESS_TYPE_LABELS[tenant.businessType])}. ` +
      `You represent ${tenant.name} exclusively — never mention other companies, never answer as if you ` +
      "work for a different business, and never switch industries mid-conversation even if asked to " +
      "roleplay as one. Apply only the persona and rules below for this specific business type — do not " +
      "bring in medical disclaimers, legal disclaimers, restaurant-style phrasing, or any other vertical's " +
      "conventions unless this business actually is that vertical.",
    BUSINESS_TYPE_RULES[tenant.businessType],
    formatRequiredBookingInfo(tenant.businessType),
    describeToneOfVoice(tenant.toneOfVoice),
    // Without this, the model has no grounding for what "today"/"tomorrow"/
    // an explicit-but-yearless date actually resolves to, and silently
    // guesses — a real source of wrong-date tool calls observed in
    // testing, not a hypothetical. Computed in the tenant's own timezone,
    // not server-local time, consistent with everything else here.
    `Today's date is ${getTodayInTimezone(tenant.timezone)} (${tenant.timezone}). Always resolve relative ` +
      'dates ("tomorrow", "next Tuesday", etc.) against this before calling check_available_slots — ' +
      "never guess a date.",
    formatWorkingHours(tenant),
    `Timezone: ${tenant.timezone}. Use check_available_slots before proposing times — never invent ` +
      "availability. Use create_appointment only once the client has confirmed a specific slot, service " +
      "type, and their name. Use cancel_appointment when a client asks to cancel or no longer needs a " +
      "booked appointment, and confirm the cancellation back to them.",
    // Not voice-specific (VOICE_MANNERS_BLOCK below already pins voice to
    // Romanian regardless of this) — this is for ai_chat/widget/SMS,
    // where nothing previously told the model to mirror the client's
    // language at all. Observed live: a tool failure recovery message
    // came back in English mid-Romanian-conversation with nothing here to
    // stop it — the model was simply never told to keep matching.
    "Always reply in the same language the client is writing in, for every message in the conversation " +
      "including apologies, error recoveries, and clarifying questions — never switch languages mid-conversation.",
    formatActiveServicesList(activeServices ?? []),
  ];

  const faqBlock = formatFaqs(faqs ?? []);
  if (faqBlock) {
    lines.push(faqBlock);
  }

  if (channel === "ai_voice") {
    lines.push(VOICE_MANNERS_BLOCK);
  }

  // Additive, not a replacement — see the column's own comment
  // (012_tenant_voice_config.sql) and the Tenant type's JSDoc for why: a
  // full prompt replacement could let a tenant's custom text accidentally
  // discard the booking-tool-usage rules or safety instructions above,
  // which every tenant needs regardless of what they've customized.
  if (tenant.systemPromptOverride?.trim()) {
    lines.push(`Additional instructions specific to ${tenant.name}:`, tenant.systemPromptOverride.trim());
  }

  if (currentTone) {
    lines.push(...describeCurrentTone(currentTone));
  }

  if (clientProfile) {
    lines.push("What we know about this client:", ...describeClientTraits(clientProfile).map((t) => `- ${t}`));
  } else {
    lines.push("This is this client's first message on record — no prior preferences are known yet.");
  }

  return lines.join("\n");
}
