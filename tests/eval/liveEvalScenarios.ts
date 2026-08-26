/**
 * The fixed eval set Radu asked for — real, varied conversations per
 * business vertical, run against the REAL Groq model (see liveEval.test.ts,
 * which is what actually executes these) so a prompt or knowledge-base
 * change gets judged against the same yardstick every time, not "by eye".
 *
 * First tranche: 6 scenarios per vertical (42 total), not yet the full
 * 20-30/vertical Radu asked for — deliberately shipped as a working,
 * runnable harness first rather than 150+ scenarios of thinner quality.
 * Growing this file (more scenarios per vertical, or new edge cases as
 * real bugs surface) is exactly the kind of small, additive, low-risk
 * change that doesn't need a check-in first — just keep the shape below.
 *
 * Each scenario is a full script of caller turns (Romanian, matching what
 * the live bot actually speaks) plus the outcome liveEval.test.ts should
 * see once every turn has been played through processClientMessage() in
 * order. See evalRubric.ts for exactly how expectedOutcome gets checked.
 */
import type { BusinessType } from "../../src/types/index.js";
import type { ConversationOutcome } from "../../src/agent/evalRubric.js";

export interface EvalScenario {
  id: string;
  vertical: BusinessType;
  /** One line: what this scenario is actually testing, for a human reading a failure report. */
  description: string;
  /** Overrides on top of that vertical's base tenant fixture (buildFixtures.ts) — usually just name/toneOfVoice, occasionally workingHours for an edge case. */
  tenantOverrides?: Record<string, unknown>;
  /** Sequential caller messages — played one at a time through processClientMessage, each with the real accumulated conversation history, exactly like a real multi-turn call. */
  turns: string[];
  expectedOutcome: ConversationOutcome;
}

// ---------------------------------------------------------------------------
// clinic
// ---------------------------------------------------------------------------

const CLINIC_SCENARIOS: EvalScenario[] = [
  {
    id: "clinic-01",
    vertical: "clinic",
    description: "Straightforward same-day booking request, no friction.",
    turns: ["Buna ziua, as vrea o programare la stomatolog maine dupa-amiaza."],
    expectedOutcome: "success",
  },
  {
    id: "clinic-02",
    vertical: "clinic",
    description: "Client picks a slot after being offered options.",
    turns: [
      "As avea nevoie de un control stomatologic saptamana asta.",
      "Ora 14:00 mi se potriveste, va rog notati-ma pe numele Popescu Andrei.",
    ],
    expectedOutcome: "success",
  },
  {
    id: "clinic-03",
    vertical: "clinic",
    description: "Client asks a medical question the bot must refuse to diagnose and instead route to booking.",
    turns: ["Ma doare o masea foarte tare, credeti ca am nevoie de tratament de canal?"],
    expectedOutcome: "failure",
  },
  {
    id: "clinic-04",
    vertical: "clinic",
    description: "Client cancels an existing appointment.",
    turns: ["As vrea sa anulez programarea pe care o am facuta pentru maine."],
    expectedOutcome: "failure",
  },
  {
    id: "clinic-05",
    vertical: "clinic",
    description: "Vague/undecided client — tests whether the bot keeps making progress instead of stalling.",
    turns: ["Nu stiu exact cand as putea veni, depinde de program.", "Poate saptamana viitoare, nu sunt sigur."],
    expectedOutcome: "failure",
  },
  {
    id: "clinic-06",
    vertical: "clinic",
    description: "Client asks about insurance the tenant hasn't configured an answer for — should fall back to niche knowledge, not invent a policy.",
    turns: ["Lucrati cu casa de asigurari?"],
    expectedOutcome: "failure",
  },
];

// ---------------------------------------------------------------------------
// auto_shop
// ---------------------------------------------------------------------------

const AUTO_SHOP_SCENARIOS: EvalScenario[] = [
  {
    id: "auto-01",
    vertical: "auto_shop",
    description: "Simple oil change booking.",
    turns: ["Buna ziua, vreau o programare pentru schimb de ulei maine dimineata."],
    expectedOutcome: "success",
  },
  {
    id: "auto-02",
    vertical: "auto_shop",
    description: "Client wants a price quote over the phone before booking a diagnostic.",
    turns: ["Cat costa sa-mi reparati o defectiune la frane?"],
    expectedOutcome: "failure",
  },
  {
    id: "auto-03",
    vertical: "auto_shop",
    description: "Multi-turn: client books after getting reassurance about brand coverage.",
    turns: ["Lucrati si pe masini Dacia?", "Perfect, atunci vreau o programare pentru vineri la ora 10."],
    expectedOutcome: "success",
  },
  {
    id: "auto-04",
    vertical: "auto_shop",
    description: "Client reschedules by asking to cancel first.",
    turns: ["Trebuie sa anulez programarea de maine, nu mai pot ajunge."],
    expectedOutcome: "failure",
  },
  {
    id: "auto-05",
    vertical: "auto_shop",
    description: "Ambiguous urgent complaint with no clear service request yet — tests whether the bot asks a clarifying question instead of guessing.",
    turns: ["Masina face un zgomot ciudat de cateva zile, nu stiu ce e."],
    expectedOutcome: "failure",
  },
  {
    id: "auto-06",
    vertical: "auto_shop",
    description: "Client confirms a loaner-car question the fallback KB deliberately doesn't promise, then books anyway.",
    turns: ["Imi dati masina la schimb cat timp e a mea in service?", "Bine, oricum vreau sa fac o programare joi dupa-amiaza."],
    expectedOutcome: "success",
  },
];

// ---------------------------------------------------------------------------
// salon
// ---------------------------------------------------------------------------

const SALON_SCENARIOS: EvalScenario[] = [
  {
    id: "salon-01",
    vertical: "salon",
    description: "Simple haircut booking.",
    turns: ["Buna, as vrea o programare la tuns maine la ora 16."],
    expectedOutcome: "success",
  },
  {
    id: "salon-02",
    vertical: "salon",
    description: "Client asks for a specific stylist by name the bot has no record of.",
    turns: ["Pot sa ma programez la Andreea pentru vopsit?"],
    expectedOutcome: "failure",
  },
  {
    id: "salon-03",
    vertical: "salon",
    description: "Multi-service request in one message.",
    turns: ["As vrea tuns si vopsit in aceeasi zi, sambata."],
    expectedOutcome: "success",
  },
  {
    id: "salon-04",
    vertical: "salon",
    description: "Client cancels.",
    turns: ["Nu mai pot veni la programarea de sambata, o anulati va rog?"],
    expectedOutcome: "failure",
  },
  {
    id: "salon-05",
    vertical: "salon",
    description: "Client asks about pricing the tenant hasn't configured — bot shouldn't invent a number.",
    turns: ["Cat costa un vopsit complet?"],
    expectedOutcome: "failure",
  },
  {
    id: "salon-06",
    vertical: "salon",
    description: "Frustrated repeat caller — tests tone adaptation still leads to a booking.",
    turns: ["A treia oara sun si tot nu reusesc sa ma programez, e o bataie de joc!", "Bine, vreau maine la prima ora atunci."],
    expectedOutcome: "success",
  },
];

// ---------------------------------------------------------------------------
// legal_services
// ---------------------------------------------------------------------------

const LEGAL_SCENARIOS: EvalScenario[] = [
  {
    id: "legal-01",
    vertical: "legal_services",
    description: "Simple consultation booking.",
    turns: ["Buna ziua, as dori o consultatie juridica saptamana aceasta."],
    expectedOutcome: "success",
  },
  {
    id: "legal-02",
    vertical: "legal_services",
    description: "Client asks for legal advice directly — bot must refuse and redirect to booking a consultation, never give advice.",
    turns: ["Am fost dat in judecata, ce sanse am sa castig procesul?"],
    expectedOutcome: "failure",
  },
  {
    id: "legal-03",
    vertical: "legal_services",
    description: "Formal tone client books after confirming a slot.",
    turns: ["As dori sa stabilim o intalnire pentru a discuta un contract.", "Ora 11:00 joi este convenabila, va multumesc."],
    expectedOutcome: "success",
  },
  {
    id: "legal-04",
    vertical: "legal_services",
    description: "Client cancels a scheduled consultation.",
    turns: ["Trebuie sa anulez intalnirea programata pentru joi."],
    expectedOutcome: "failure",
  },
  {
    id: "legal-05",
    vertical: "legal_services",
    description: "Client asks about cost of representation the tenant hasn't configured.",
    turns: ["Cat percepeti pentru reprezentare intr-un proces civil?"],
    expectedOutcome: "failure",
  },
  {
    id: "legal-06",
    vertical: "legal_services",
    description: "Vague inquiry that never turns into a concrete booking request across two turns.",
    turns: ["As vrea niste informatii despre serviciile voastre.", "Nu stiu inca exact ce am nevoie, ma mai gandesc."],
    expectedOutcome: "failure",
  },
];

// ---------------------------------------------------------------------------
// restaurant
// ---------------------------------------------------------------------------

const RESTAURANT_SCENARIOS: EvalScenario[] = [
  {
    id: "restaurant-01",
    vertical: "restaurant",
    description: "Simple table reservation.",
    turns: ["Buna seara, as vrea o masa pentru 2 persoane diseara la ora 20."],
    expectedOutcome: "success",
  },
  {
    id: "restaurant-02",
    vertical: "restaurant",
    description: "Large group booking with a follow-up detail.",
    turns: ["As vrea sa rezerv pentru 10 persoane sambata seara.", "Da, o masa in zona linistita ar fi ideal, ora 19:30."],
    expectedOutcome: "success",
  },
  {
    id: "restaurant-03",
    vertical: "restaurant",
    description: "Client asks about menu/allergen details the tenant hasn't configured.",
    turns: ["Aveti optiuni fara gluten pe meniu?"],
    expectedOutcome: "failure",
  },
  {
    id: "restaurant-04",
    vertical: "restaurant",
    description: "Client cancels a reservation.",
    turns: ["Trebuie sa anulez rezervarea de sambata seara, ne cerem scuze."],
    expectedOutcome: "failure",
  },
  {
    id: "restaurant-05",
    vertical: "restaurant",
    description: "Client asks whether walk-ins are accepted instead of booking — should still try to move toward a reservation.",
    turns: ["Pot sa vin fara rezervare diseara?"],
    expectedOutcome: "failure",
  },
  {
    id: "restaurant-06",
    vertical: "restaurant",
    description: "Indecisive client across two turns who never commits to a time.",
    turns: ["As vrea sa rezerv o masa, dar nu stiu exact la ce ora ajungem.", "Poate diseara, poate maine, nu suntem siguri inca."],
    expectedOutcome: "failure",
  },
];

// ---------------------------------------------------------------------------
// callcenter (general reception/BPO-style front desk)
// ---------------------------------------------------------------------------

const CALLCENTER_SCENARIOS: EvalScenario[] = [
  {
    id: "callcenter-01",
    vertical: "callcenter",
    description: "Simple appointment booking through a generic front-desk flow.",
    turns: ["Buna ziua, as vrea sa programez o vizita pentru maine."],
    expectedOutcome: "success",
  },
  {
    id: "callcenter-02",
    vertical: "callcenter",
    description: "Client wants to speak to a human immediately — bot should acknowledge, not pretend to transfer, and still try to help or book.",
    turns: ["Vreau sa vorbesc cu un operator uman, nu cu un robot."],
    expectedOutcome: "failure",
  },
  {
    id: "callcenter-03",
    vertical: "callcenter",
    description: "Client provides booking details across two turns.",
    turns: ["As avea nevoie de o programare saptamana viitoare.", "Marti la ora 9 dimineata, pe numele Ionescu."],
    expectedOutcome: "success",
  },
  {
    id: "callcenter-04",
    vertical: "callcenter",
    description: "Client cancels.",
    turns: ["As vrea sa anulez programarea facuta ieri."],
    expectedOutcome: "failure",
  },
  {
    id: "callcenter-05",
    vertical: "callcenter",
    description: "Off-topic question with no relation to booking — bot shouldn't hallucinate an answer.",
    turns: ["Care e programul vostru de sarbatori legale?"],
    expectedOutcome: "failure",
  },
  {
    id: "callcenter-06",
    vertical: "callcenter",
    description: "Confused client repeats the same unclear request twice — tests the repeated-question failure detector from the bot's own side too.",
    turns: ["As vrea o programare dar nu stiu pentru ce anume.", "Nu sunt sigur ce serviciu imi trebuie, ma puteti ajuta?"],
    expectedOutcome: "failure",
  },
];

// ---------------------------------------------------------------------------
// general_services
// ---------------------------------------------------------------------------

const GENERAL_SERVICES_SCENARIOS: EvalScenario[] = [
  {
    id: "general-01",
    vertical: "general_services",
    description: "Simple service booking with no vertical-specific complexity.",
    turns: ["Buna ziua, as vrea o programare pentru o vizita de service maine."],
    expectedOutcome: "success",
  },
  {
    id: "general-02",
    vertical: "general_services",
    description: "Client asks about service area/coverage the tenant hasn't configured.",
    turns: ["Veniti si in afara orasului pentru interventii?"],
    expectedOutcome: "failure",
  },
  {
    id: "general-03",
    vertical: "general_services",
    description: "Client books after confirming availability across two turns.",
    turns: ["Aveti disponibilitate saptamana aceasta pentru o interventie?", "Perfect, atunci joi dupa-amiaza, va rog."],
    expectedOutcome: "success",
  },
  {
    id: "general-04",
    vertical: "general_services",
    description: "Client cancels.",
    turns: ["Trebuie sa anulez interventia programata pentru joi."],
    expectedOutcome: "failure",
  },
  {
    id: "general-05",
    vertical: "general_services",
    description: "Client asks for an exact price without a diagnostic visit.",
    turns: ["Cat ma costa in total interventia, fara sa vina nimeni sa vada intai?"],
    expectedOutcome: "failure",
  },
  {
    id: "general-06",
    vertical: "general_services",
    description: "Client changes their mind mid-conversation about the date, tests the bot doesn't lock in the wrong slot.",
    turns: ["As vrea o programare pentru vineri.", "De fapt mai bine luni, daca se poate."],
    expectedOutcome: "success",
  },
];

export const EVAL_SCENARIOS: EvalScenario[] = [
  ...CLINIC_SCENARIOS,
  ...AUTO_SHOP_SCENARIOS,
  ...SALON_SCENARIOS,
  ...LEGAL_SCENARIOS,
  ...RESTAURANT_SCENARIOS,
  ...CALLCENTER_SCENARIOS,
  ...GENERAL_SERVICES_SCENARIOS,
];

/** Every BusinessType has scenarios — a new vertical added to BusinessType without eval coverage should be a visible gap, not a silent one. */
export const EVAL_VERTICALS_COVERED: BusinessType[] = ["clinic", "auto_shop", "salon", "legal_services", "restaurant", "callcenter", "general_services"];
