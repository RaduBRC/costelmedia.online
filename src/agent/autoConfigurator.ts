/**
 * Auto-configurator ("Auto-Generate Agent Configuration", OnboardingPage.tsx
 * / SettingsPage.tsx): turns a short, free-text description of a business
 * into a starting AI-agent configuration — a dynamic greeting, a services
 * list (name/duration/price), FAQs, and the specific fields this business
 * needs collected before booking — via one Groq JSON-mode call. Built so a
 * non-technical owner can type a paragraph instead of filling out
 * services/FAQs one at a time from a blank page.
 *
 * Additive, not destructive: this INSERTS services/FAQs alongside whatever
 * already exists for the tenant (never deletes or replaces existing rows)
 * and only overwrites greetingMessage/requiredBookingFields on the tenant
 * row itself. That's the right behavior for both real call sites — a
 * brand-new tenant with nothing configured yet, or an existing tenant
 * deliberately re-running it to add more — and never silently destroys
 * something a human already typed in by hand elsewhere in the dashboard.
 */
import { insertFaq, insertService, updateTenant } from "../db/supabase.js";
import { callGroq, GroqUnavailableError } from "./groqAgent.js";
import type { BusinessType, Currency, Faq, Service, Tenant } from "../types/index.js";

/** Thrown for a bad request body (empty/too-long description) or a Groq response that fails shape validation — distinct from GroqUnavailableError (network/auth/rate-limit), so the route can tell "your input was bad" apart from "the AI service itself is unavailable" and respond with the right status code for each. */
export class AutoConfigureValidationError extends Error {}

const MAX_DESCRIPTION_LENGTH = 2000;
const MIN_FAQS = 5;
const MAX_FAQS = 10;
const MAX_SERVICES = 15;
const MAX_REQUIRED_FIELDS = 8;
const VALID_CURRENCIES: readonly Currency[] = ["RON", "EUR"];

function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (VALID_CURRENCIES as readonly string[]).includes(value);
}

interface GeneratedService {
  name: string;
  durationMinutes: number;
  priceMinorUnits: number;
  currency: Currency;
  description: string | null;
}

interface GeneratedFaq {
  question: string;
  answer: string;
}

interface AutoConfigureParsed {
  greetingMessage: string;
  services: GeneratedService[];
  faqs: GeneratedFaq[];
  requiredBookingFields: string[];
}

/**
 * Defensive, field-by-field validation of Groq's JSON response — same
 * rigor as groqAgent.ts's own isToneAssessment: an LLM's JSON-mode output
 * is schema-compliant JSON, not necessarily semantically correct (a price
 * that's actually a string, a missing field, an empty array), so every
 * field is checked and clamped/dropped rather than trusted as-is. Throws
 * AutoConfigureValidationError with a specific reason rather than
 * silently coercing bad data into the database.
 */
function parseAndValidate(raw: string): AutoConfigureParsed {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new AutoConfigureValidationError("The AI response was not valid JSON.");
  }
  if (typeof candidate !== "object" || candidate === null) {
    throw new AutoConfigureValidationError("The AI response was not a JSON object.");
  }
  const record = candidate as Record<string, unknown>;

  const greetingMessage = record["greeting_message"];
  if (typeof greetingMessage !== "string" || greetingMessage.trim().length === 0) {
    throw new AutoConfigureValidationError("The AI response was missing a valid greeting_message.");
  }

  const servicesRaw = record["services_list"];
  if (!Array.isArray(servicesRaw) || servicesRaw.length === 0) {
    throw new AutoConfigureValidationError("The AI response was missing a non-empty services_list.");
  }
  const services: GeneratedService[] = servicesRaw.slice(0, MAX_SERVICES).map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new AutoConfigureValidationError(`services_list[${index}] was not an object.`);
    }
    const service = entry as Record<string, unknown>;
    const name = service["name"];
    const durationMinutes = service["duration_minutes"];
    const priceMinorUnits = service["price_minor_units"];
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new AutoConfigureValidationError(`services_list[${index}].name was missing or empty.`);
    }
    if (typeof durationMinutes !== "number" || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      throw new AutoConfigureValidationError(`services_list[${index}].duration_minutes must be a positive number.`);
    }
    if (typeof priceMinorUnits !== "number" || !Number.isFinite(priceMinorUnits) || priceMinorUnits < 0) {
      throw new AutoConfigureValidationError(`services_list[${index}].price_minor_units must be a non-negative number.`);
    }
    return {
      name: name.trim(),
      // Clamped to whole minutes, never fractional/zero — a booking slot
      // duration has to be a real, usable value regardless of what the
      // model returned.
      durationMinutes: Math.max(5, Math.round(durationMinutes)),
      priceMinorUnits: Math.max(0, Math.round(priceMinorUnits)),
      currency: isCurrency(service["currency"]) ? service["currency"] : "RON",
      description: typeof service["description"] === "string" && service["description"].trim() ? service["description"].trim() : null,
    };
  });

  const faqsRaw = record["faq_items"];
  if (!Array.isArray(faqsRaw) || faqsRaw.length < MIN_FAQS) {
    throw new AutoConfigureValidationError(`The AI response's faq_items had fewer than the required ${MIN_FAQS} entries.`);
  }
  const faqs: GeneratedFaq[] = faqsRaw.slice(0, MAX_FAQS).map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new AutoConfigureValidationError(`faq_items[${index}] was not an object.`);
    }
    const faq = entry as Record<string, unknown>;
    const question = faq["question"];
    const answer = faq["answer"];
    if (typeof question !== "string" || question.trim().length === 0 || typeof answer !== "string" || answer.trim().length === 0) {
      throw new AutoConfigureValidationError(`faq_items[${index}] was missing a question or answer.`);
    }
    return { question: question.trim(), answer: answer.trim() };
  });

  const requiredFieldsRaw = record["required_booking_fields"];
  if (!Array.isArray(requiredFieldsRaw) || requiredFieldsRaw.length === 0) {
    throw new AutoConfigureValidationError("The AI response was missing a non-empty required_booking_fields array.");
  }
  const requiredBookingFields = requiredFieldsRaw
    .filter((field): field is string => typeof field === "string" && field.trim().length > 0)
    .slice(0, MAX_REQUIRED_FIELDS)
    .map((field) => field.trim());
  if (requiredBookingFields.length === 0) {
    throw new AutoConfigureValidationError("required_booking_fields contained no valid strings.");
  }

  return { greetingMessage: greetingMessage.trim(), services, faqs, requiredBookingFields };
}

const NICHE_EXAMPLES: Record<BusinessType, string> = {
  auto_shop: '{"greeting_message":"Bună ziua, ați sunat la Auto Doc Service, serviciul de reparații auto. Cu ce vă pot ajuta?","services_list":[{"name":"Schimb ulei","duration_minutes":30,"price_minor_units":15000,"currency":"RON","description":"Include filtru de ulei."}],"faq_items":[{"question":"Oferiți tractare?","answer":"Da, tractare gratuită în limita a 10 km pentru reparații majore."}],"required_booking_fields":["Marca și modelul mașinii","Descrierea problemei"]}',
  clinic:
    '{"greeting_message":"Bună ziua, ați sunat la Metro Dental Clinic, serviciul de programări medicale. Cu ce vă pot ajuta?","services_list":[{"name":"Consultație generală","duration_minutes":30,"price_minor_units":20000,"currency":"RON","description":null}],"faq_items":[{"question":"Acceptați asigurare?","answer":"Vă rugăm confirmați direct cu recepția ce asigurări acceptăm."}],"required_booking_fields":["Tipul serviciului/programării dorite","Medicul preferat, dacă există"]}',
  salon:
    '{"greeting_message":"Bună ziua, ați sunat la Glow Beauty Salon, serviciul de înfrumusețare. Cu ce vă pot ajuta?","services_list":[{"name":"Tuns și styling","duration_minutes":45,"price_minor_units":12000,"currency":"RON","description":null}],"faq_items":[{"question":"Pot alege un anumit stilist?","answer":"Da, spuneți-mi preferința și verific disponibilitatea."}],"required_booking_fields":["Tipul serviciului dorit","Stilistul preferat, dacă există"]}',
  callcenter:
    '{"greeting_message":"Bună ziua, ați sunat la Helpline Pro, serviciul de suport clienți. Cu ce vă pot ajuta?","services_list":[{"name":"Apel de suport standard","duration_minutes":15,"price_minor_units":0,"currency":"RON","description":null}],"faq_items":[{"question":"Cât durează până mă sună cineva înapoi?","answer":"În funcție de urgență, de obicei în aceeași zi lucrătoare."}],"required_booking_fields":["Descrierea problemei sau cererii","Nivelul de urgență","Un număr de telefon pentru apel de retur"]}',
  legal_services:
    '{"greeting_message":"Bună ziua, ați sunat la Ionescu & Partners, serviciul de consultanță juridică. Cu ce vă pot ajuta?","services_list":[{"name":"Consultație inițială","duration_minutes":60,"price_minor_units":25000,"currency":"RON","description":null}],"faq_items":[{"question":"Oferiți consultații gratuite?","answer":"Vă rugăm confirmați direct — politica variază."}],"required_booking_fields":["Subiectul general al consultației"]}',
  restaurant:
    '{"greeting_message":"Bună ziua, ați sunat la Trattoria Bella, serviciul de rezervări. Cu ce vă pot ajuta?","services_list":[{"name":"Rezervare masă","duration_minutes":90,"price_minor_units":0,"currency":"RON","description":null}],"faq_items":[{"question":"Aveți meniu vegetarian?","answer":"Da, avem mai multe opțiuni vegetariene."}],"required_booking_fields":["Numărul de persoane","Cerințe speciale"]}',
  general_services:
    '{"greeting_message":"Bună ziua, ați sunat la Acme Services, serviciul de programări. Cu ce vă pot ajuta?","services_list":[{"name":"Serviciu standard","duration_minutes":60,"price_minor_units":10000,"currency":"RON","description":null}],"faq_items":[{"question":"Cum pot face o programare?","answer":"Spuneți-mi ce serviciu doriți și data preferată."}],"required_booking_fields":["Serviciul specific dorit"]}',
};

async function requestConfiguration(tenant: Tenant, description: string): Promise<AutoConfigureParsed> {
  const systemPrompt =
    "You configure AI receptionist agents for small businesses from a short description of the business. " +
    `This business is already registered as "${tenant.name}", a ${tenant.businessType.replace("_", " ")}. ` +
    "Read the business owner's description below and respond with ONLY a JSON object of this exact shape:\n" +
    "{\n" +
    '  "greeting_message": "<a Romanian phone-greeting sentence, MUST include the literal placeholder {company_name} in place of the business name>",\n' +
    '  "services_list": [{"name": "<string>", "duration_minutes": <integer>, "price_minor_units": <integer, price in bani/cents>, "currency": "RON"|"EUR", "description": "<string or null>"}],\n' +
    '  "faq_items": [{"question": "<string>", "answer": "<string>"}],\n' +
    '  "required_booking_fields": ["<short string describing one piece of information to collect before booking>"]\n' +
    "}\n" +
    `Requirements:\n` +
    "- greeting_message: Romanian, natural, must contain the literal text {company_name} (not the real name) so it can be personalized later. Keep it one sentence.\n" +
    `- services_list: 2–${MAX_SERVICES} realistic services for this specific business, each with a plausible duration and a realistic RON price for the Romanian market (prices in bani, i.e. price_minor_units 15000 = 150.00 RON) based on what the description says this business actually offers.\n` +
    `- faq_items: at least ${MIN_FAQS} Q&A pairs a real caller would plausibly ask THIS specific business, grounded in details from the description (not generic industry filler) — questions and answers both in Romanian.\n` +
    "- required_booking_fields: the SPECIFIC pieces of information (beyond name/phone/date-time, which are always collected separately and must NOT be repeated here) this specific business genuinely needs to book an appointment — e.g. an auto shop needs the vehicle's make/model, a call center needs urgency level, a clinic needs the type of appointment. Base this on the business type AND anything specific the description mentions, not a generic template.\n" +
    "Respond with ONLY the JSON object, no other text.\n\n" +
    `Example shape (a DIFFERENT, unrelated business, for format reference only — never reuse any of this content): ${NICHE_EXAMPLES[tenant.businessType]}`;

  const response = await callGroq(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: description },
    ],
    { jsonMode: true },
  );

  if (!response.content) {
    throw new GroqUnavailableError("Groq auto-configure response had no content.");
  }
  return parseAndValidate(response.content);
}

export interface AutoConfigureResult {
  greetingMessage: string;
  createdServices: Service[];
  createdFaqs: Faq[];
  requiredBookingFields: string[];
}

/**
 * The full flow: validate input, call Groq, then persist. Persistence
 * happens sequentially (not Promise.all) and stops on the first failure —
 * a partial write (e.g. the tenant row updated but only 2 of 6 services
 * inserted before an error) is an acceptable, visible partial success
 * here (the route surfaces exactly what was created), not something worth
 * wrapping in a transaction for a one-time onboarding convenience feature.
 */
export async function autoConfigureTenant(tenant: Tenant, description: string): Promise<AutoConfigureResult> {
  const trimmed = description.trim();
  if (!trimmed) {
    throw new AutoConfigureValidationError("description must not be empty.");
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new AutoConfigureValidationError(`description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`);
  }

  const parsed = await requestConfiguration(tenant, trimmed);

  await updateTenant(tenant.id, {
    greetingMessage: parsed.greetingMessage,
    requiredBookingFields: parsed.requiredBookingFields,
  });

  const createdServices: Service[] = [];
  for (const service of parsed.services) {
    createdServices.push(
      await insertService({
        tenantId: tenant.id,
        name: service.name,
        durationMinutes: service.durationMinutes,
        priceMinorUnits: service.priceMinorUnits,
        currency: service.currency,
        description: service.description,
      }),
    );
  }

  const createdFaqs: Faq[] = [];
  for (const [index, faq] of parsed.faqs.entries()) {
    createdFaqs.push(await insertFaq({ tenantId: tenant.id, question: faq.question, answer: faq.answer, displayOrder: index }));
  }

  return {
    greetingMessage: parsed.greetingMessage,
    createdServices,
    createdFaqs,
    requiredBookingFields: parsed.requiredBookingFields,
  };
}
