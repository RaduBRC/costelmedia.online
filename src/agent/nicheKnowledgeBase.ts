/**
 * Static, per-industry fallback knowledge base — general Q&A a business in
 * this vertical almost always gets asked, regardless of which specific
 * tenant it is. Distinct from a tenant's own `tenant_faqs` (real, tenant-
 * authored answers, always consulted first — see promptBuilder.ts): this
 * is what the agent falls back to when the caller asks something the
 * tenant never configured an answer for, so it can still give a real,
 * industry-correct answer instead of immediately admitting ignorance.
 *
 * These are intentionally generic/non-committal on anything that varies
 * business-to-business (price, exact turnaround time, insurance accepted)
 * — the answers are phrased to be true for "a typical business in this
 * industry" without inventing this specific tenant's actual policy. The
 * system prompt's own instructions (formatNicheFallbackKnowledge below)
 * make that boundary explicit to the model too: this is general industry
 * knowledge to draw on, not a stand-in for the tenant's real answer.
 */
import type { BusinessType } from "../types/index.js";

export interface NicheFaqEntry {
  question: string;
  answer: string;
}

const AUTO_SHOP_FALLBACK: NicheFaqEntry[] = [
  {
    question: "Do I need to book an appointment or can I just come in?",
    answer:
      "Most auto shops take walk-ins for quick jobs but recommend booking ahead for anything that needs parts ordered or a longer diagnostic — booking guarantees you a bay and a specific time.",
  },
  {
    question: "How long does an oil change / basic service usually take?",
    answer: "A standard oil change or basic service typically takes 30–60 minutes; more involved repairs depend on the diagnosis and parts availability.",
  },
  {
    question: "Do you offer a loaner car or shuttle service?",
    answer: "That varies by shop — ask this specific location directly, and I'll note it down so they can confirm when they follow up.",
  },
  {
    question: "Can you give me a price over the phone?",
    answer:
      "An exact price usually needs the vehicle to be seen first, since the actual issue can differ from what it sounds like over the phone — I can get you booked in for a diagnostic to find out for sure.",
  },
  {
    question: "What information do you need from me to book a repair?",
    answer: "Generally the vehicle's make and model, a description of the issue, and your preferred date/time — I'll walk you through it.",
  },
  {
    question: "Do you work on all car brands?",
    answer: "Most general auto repair shops service all major makes — for anything brand-specific (e.g. dealership-only diagnostics), it's worth confirming directly.",
  },
];

const CLINIC_FALLBACK: NicheFaqEntry[] = [
  {
    question: "Do you accept walk-ins or is an appointment required?",
    answer: "Most clinics prefer a scheduled appointment so a provider has time set aside for you — I can help you find the next available slot.",
  },
  {
    question: "What should I bring to my appointment?",
    answer: "Generally a valid ID and, if you have one, your insurance card — I can note any other specifics this office wants and have them confirm.",
  },
  {
    question: "Do you accept my insurance?",
    answer: "Insurance acceptance varies by provider and plan — I'd recommend confirming your specific plan directly with the office, or I can pass your question along.",
  },
  {
    question: "How early should I arrive before my appointment?",
    answer: "A common guideline is 10–15 minutes early, especially for a first visit that may involve paperwork.",
  },
  {
    question: "What's your cancellation policy?",
    answer: "Most clinics ask for at least 24 hours' notice to cancel or reschedule — let me know if you need to change your appointment and I'll take care of it.",
  },
  {
    question: "Can I get medical advice over the phone?",
    answer: "I'm not able to give medical advice or a diagnosis — that's something only a provider can do once you're seen. I can help get you booked in, though.",
  },
];

const SALON_FALLBACK: NicheFaqEntry[] = [
  {
    question: "How far in advance should I book?",
    answer: "It depends on the service and how busy the salon is — popular time slots (evenings, weekends) tend to fill up faster, so booking a few days ahead is a safe bet.",
  },
  {
    question: "Can I request a specific stylist/technician?",
    answer: "Yes — just let me know who you'd like, and I'll check their availability for the date/time you want.",
  },
  {
    question: "What's your cancellation or no-show policy?",
    answer: "Most salons ask for at least 24 hours' notice for cancellations — I can help you reschedule if something comes up.",
  },
  {
    question: "How long does a typical appointment take?",
    answer: "It really depends on the service — a simple trim is much faster than a full color treatment. I'll check the expected duration when I book you in.",
  },
  {
    question: "Do you offer consultations before a big change (color, cut)?",
    answer: "Many salons do offer a quick consultation, in person or by phone, for a significant change — worth asking for when you book.",
  },
  {
    question: "What products do you use?",
    answer: "That varies by salon and stylist — happy to pass the question along so you get an accurate answer.",
  },
];

const CALLCENTER_FALLBACK: NicheFaqEntry[] = [
  {
    question: "How quickly will someone get back to me?",
    answer: "Response time depends on the urgency and current volume — if this is urgent, let me know and I'll flag it as high priority.",
  },
  {
    question: "Can I speak to a manager or a specific department?",
    answer: "I can take down what you need and make sure it gets routed to the right person — a callback is usually the fastest way to reach the right specialist.",
  },
  {
    question: "What are your support hours?",
    answer: "I can take your request any time, but a live callback will happen during this business's normal operating hours — let me get your details either way.",
  },
  {
    question: "Do I need an account or reference number to get help?",
    answer: "It helps if you have one, but it's not required — I can look things up with your name and phone number too.",
  },
  {
    question: "How do I follow up on a request I already made?",
    answer: "Give me a few details (your name, phone number, or a reference if you have one) and I'll make sure it's noted and someone follows up.",
  },
  {
    question: "Is this call recorded?",
    answer: "That depends on this business's own policy — I'd recommend asking a live representative directly if that matters to you.",
  },
];

const LEGAL_SERVICES_FALLBACK: NicheFaqEntry[] = [
  {
    question: "Do you offer a free initial consultation?",
    answer: "That varies by practice — I can note your question and have someone confirm exactly what applies here.",
  },
  {
    question: "Can you tell me if I have a case / give me legal advice now?",
    answer: "I'm not able to give legal advice or assess a case myself — that's strictly something the attorney does once you're actually consulting with them. I can get you booked in for that.",
  },
  {
    question: "How much does a consultation cost?",
    answer: "Consultation fees vary by practice and matter type — I'd recommend confirming directly, and I can pass your question along.",
  },
  {
    question: "What should I bring to a consultation?",
    answer: "Generally, any documents relevant to your situation (contracts, correspondence, prior filings) are helpful to bring — I can check if this office has specific requirements.",
  },
  {
    question: "Is what I tell you confidential?",
    answer: "Attorney-client privilege applies once you're actually consulting with the attorney — for scheduling purposes, I'd still keep any details you share to just what's needed to book you in.",
  },
  {
    question: "How soon can I get an appointment?",
    answer: "That depends on the attorney's current availability — let me check what's open for you.",
  },
];

const RESTAURANT_FALLBACK: NicheFaqEntry[] = [
  {
    question: "Do you take walk-ins or is a reservation required?",
    answer: "Walk-ins are usually welcome, but a reservation guarantees your table, especially on busy nights — happy to book one for you.",
  },
  {
    question: "Can you accommodate dietary restrictions/allergies?",
    answer: "Most restaurants can accommodate common dietary needs with notice — let me know what you need and I'll pass it along with your reservation.",
  },
  {
    question: "Is there a dress code?",
    answer: "That varies by restaurant — I'd recommend confirming directly if you're unsure, but I can note the question for you.",
  },
  {
    question: "Do you have parking or is it easy to get to?",
    answer: "I don't have exact parking details on hand, but I can pass that question along so you get accurate directions.",
  },
];

const GENERAL_SERVICES_FALLBACK: NicheFaqEntry[] = [
  {
    question: "How do I book an appointment?",
    answer: "Just tell me what service you need and your preferred date/time, and I'll get you booked in.",
  },
  {
    question: "What's your cancellation policy?",
    answer: "Most businesses ask for advance notice to cancel or reschedule — let me know if your plans change and I'll help sort it out.",
  },
  {
    question: "Can I get a price estimate over the phone?",
    answer: "That depends on the specific service — I can note your question and make sure you get an accurate answer.",
  },
  {
    question: "What are your hours?",
    answer: "I can check the business's working hours for you — just ask, or tell me what day you're thinking of.",
  },
];

/** One tailored fallback list per BusinessType — every key required, so a new vertical added to BusinessType can't silently ship with no fallback knowledge at all. */
export const NICHE_FALLBACK_FAQS: Record<BusinessType, NicheFaqEntry[]> = {
  auto_shop: AUTO_SHOP_FALLBACK,
  clinic: CLINIC_FALLBACK,
  salon: SALON_FALLBACK,
  callcenter: CALLCENTER_FALLBACK,
  legal_services: LEGAL_SERVICES_FALLBACK,
  restaurant: RESTAURANT_FALLBACK,
  general_services: GENERAL_SERVICES_FALLBACK,
};

/**
 * Formats this business type's fallback matrix for injection into the
 * system prompt, with an explicit priority order: the tenant's own FAQs
 * (formatFaqs, promptBuilder.ts) are authoritative and checked first; this
 * is the second line of defense before the model is allowed to admit it
 * doesn't know — never a substitute for a real, tenant-specific answer,
 * and never to be presented as if it were this specific business's own
 * policy (prices, exact hours, insurance, etc. are deliberately generic
 * above for exactly this reason).
 */
export function formatNicheFallbackKnowledge(businessType: BusinessType): string {
  const entries = NICHE_FALLBACK_FAQS[businessType];
  const lines = entries.map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`);
  return (
    "General knowledge base for this industry — consult this ONLY if the client's question isn't answered by " +
    "this business's own FAQs above. These are general, industry-typical answers, not this specific business's " +
    "own policy — never state a specific price, exact hours, or a guaranteed policy from this list as if it " +
    "were confirmed fact for this business; phrase it as general guidance and offer to confirm the specifics. " +
    "Only if a question isn't covered by the tenant's own FAQs above OR this general knowledge base should you " +
    "honestly say you don't have that specific information and offer to have someone follow up — never invent " +
    `an answer.\n\n${lines.join("\n\n")}`
  );
}
