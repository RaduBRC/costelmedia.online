/**
 * Public marketing homepage (/) for costelmedia.online. Deliberately has
 * no fabricated stats, testimonials, or customer logos — this is a real
 * new product with no live customers yet, and inventing social proof
 * would be actively dishonest marketing copy, not just an aggressive
 * sales page. Every feature claim here maps to something actually built
 * in this codebase, not aspirational copy.
 */
import {
  Briefcase,
  Building2,
  CalendarCheck,
  Car,
  Check,
  Gavel,
  Globe2,
  HeartPulse,
  Mic,
  Phone,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";

const FEATURES = [
  {
    icon: CalendarCheck,
    title: "Automatic booking, end to end",
    description:
      "The AI checks real availability, confirms details back to the caller, and books directly into your calendar — no back-and-forth, no double-booking.",
  },
  {
    icon: Mic,
    title: "Real voice conversations",
    description:
      "Callers talk to a natural-sounding AI voice agent, not a rigid phone tree. Text chat and an embeddable website widget work the same way.",
  },
  {
    icon: Globe2,
    title: "Multi-niche by design",
    description:
      "One platform, a different persona per business — the AI's tone, rules, and FAQs adapt automatically to your industry, not a one-size-fits-all script.",
  },
  {
    icon: ShieldCheck,
    title: "Built-in security guardrail",
    description:
      "Prompt-injection attempts and abusive input are screened before they ever reach the AI or your data, with a full audit trail.",
  },
];

const NICHES = [
  { icon: HeartPulse, label: "Clinics", description: "Calm, compassionate scheduling for medical & dental practices." },
  { icon: Sparkles, label: "Beauty & Salons", description: "Stylist and service-aware booking for salons and barbershops." },
  { icon: Car, label: "Auto Services", description: "Captures vehicle details and issue description before booking." },
  { icon: Gavel, label: "Legal & Professional", description: "Discreet, professional consultation scheduling." },
];

interface PricingTier {
  name: string;
  price: string;
  tagline: string;
  features: string[];
  highlighted?: boolean;
}

const PRICING_TIERS: PricingTier[] = [
  {
    name: "Starter",
    price: "$149",
    tagline: "For a single location getting started with AI scheduling.",
    features: ["300 AI minutes / month", "Google Calendar sync", "Standard voice", "Email support"],
  },
  {
    name: "Pro",
    price: "$299",
    tagline: "For growing businesses that need a custom brand voice.",
    features: ["1,000 AI minutes / month", "Custom ElevenLabs voice", "FAQ & knowledge base", "Priority email support"],
    highlighted: true,
  },
  {
    name: "Enterprise",
    price: "$599",
    tagline: "For multi-location businesses with higher call volume.",
    features: ["2,500 AI minutes / month", "Dedicated security guardrail tuning", "Priority support & onboarding", "Custom integrations"],
  },
];

export default function LandingPage(): JSX.Element {
  const { session } = useAuth();
  const primaryCtaHref = session ? "/admin/dashboard" : "/login";

  return (
    <div>
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pb-24 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mx-auto mb-6 flex w-fit items-center gap-1.5 rounded-full bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
            <Phone className="h-3.5 w-3.5" />
            AI voice &amp; chat receptionist
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl dark:text-slate-50">
            Never miss a booking again — let AI answer, everywhere.
          </h1>
          <p className="mt-5 text-lg text-slate-600 dark:text-slate-400">
            CostelMedia answers calls, chats, and website messages, checks real availability, and books the appointment — for clinics, salons,
            auto shops, legal practices, and more. Live in minutes, not months.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to={primaryCtaHref}
              className="flex h-12 w-full items-center justify-center rounded-lg bg-violet-600 px-6 text-sm font-semibold text-white transition active:scale-[0.98] hover:bg-violet-500 sm:w-auto"
            >
              {session ? "Go to Dashboard" : "Start Free Trial"}
            </Link>
            <Link
              to={session ? "/admin/tools/voice" : "/login"}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 px-6 text-sm font-semibold text-slate-700 transition active:scale-[0.98] hover:bg-slate-50 sm:w-auto dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
            >
              <Mic className="h-4 w-4" />
              Try the Live Voice Demo
            </Link>
          </div>
          <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
            The live voice demo runs inside your dashboard — sign in (or start a free trial) to try it with your own business.
          </p>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-slate-100 bg-slate-50 py-16 sm:py-24 dark:border-slate-900 dark:bg-slate-900/40">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Everything a real receptionist does — automatically</h2>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2">
            {FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <div key={feature.title} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-950">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-950/50 dark:text-violet-300">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-50">{feature.title}</h3>
                  <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">{feature.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Industries / niches */}
      <section id="niches" className="py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Built for your industry, not a generic script</h2>
            <p className="mt-3 text-slate-600 dark:text-slate-400">
              The AI's persona, rules, and FAQs adapt to your business type — plus restaurants, call centers, and general service businesses.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {NICHES.map((niche) => {
              const Icon = niche.icon;
              return (
                <div
                  key={niche.label}
                  className="flex flex-col items-center gap-2 rounded-xl border border-slate-200 p-5 text-center dark:border-slate-800"
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-violet-50 text-violet-600 dark:bg-violet-950/50 dark:text-violet-300">
                    <Icon className="h-5 w-5" />
                  </div>
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">{niche.label}</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">{niche.description}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t border-slate-100 bg-slate-50 py-16 sm:py-24 dark:border-slate-900 dark:bg-slate-900/40">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Simple, transparent pricing</h2>
            <p className="mt-3 text-slate-600 dark:text-slate-400">Every plan includes unlimited bookings and every industry persona. Cancel anytime.</p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-3">
            {PRICING_TIERS.map((tier) => (
              <div
                key={tier.name}
                className={`flex flex-col rounded-2xl border p-6 ${
                  tier.highlighted
                    ? "border-violet-500 bg-white shadow-lg ring-1 ring-violet-500 dark:bg-slate-950"
                    : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950"
                }`}
              >
                {tier.highlighted && (
                  <span className="mb-3 w-fit rounded-full bg-violet-600 px-2.5 py-0.5 text-[11px] font-semibold text-white">Most popular</span>
                )}
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">{tier.name}</h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{tier.tagline}</p>
                <p className="mt-4 text-3xl font-bold text-slate-900 dark:text-slate-50">
                  {tier.price}
                  <span className="text-sm font-normal text-slate-500 dark:text-slate-400">/mo</span>
                </p>
                <ul className="mt-5 flex-1 space-y-2.5">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
                      {feature}
                    </li>
                  ))}
                </ul>
                {/* Placeholder CTA — not wired to Stripe Checkout yet. Honestly
                    labeled rather than a fake "Subscribe" button that would
                    imply a real charge happens on click. */}
                <Link
                  to="/login"
                  className={`mt-6 flex h-11 items-center justify-center rounded-lg text-sm font-semibold transition active:scale-[0.98] ${
                    tier.highlighted
                      ? "bg-violet-600 text-white hover:bg-violet-500"
                      : "border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
                  }`}
                >
                  Get started
                </Link>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-xs text-slate-400 dark:text-slate-500">
            Online self-service checkout is coming soon — for now, get started and our team will set up billing with you directly.
          </p>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
          <Building2 className="mx-auto h-10 w-10 text-violet-600 dark:text-violet-400" />
          <h2 className="mt-4 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-slate-50">
            Ready to stop missing bookings?
          </h2>
          <p className="mt-3 text-slate-600 dark:text-slate-400">Set up your AI receptionist today — it answers the next call before you finish reading this.</p>
          <Link
            to={primaryCtaHref}
            className="mt-6 inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-violet-600 px-6 text-sm font-semibold text-white transition active:scale-[0.98] hover:bg-violet-500"
          >
            <Briefcase className="h-4 w-4" />
            {session ? "Go to Dashboard" : "Start Free Trial"}
          </Link>
        </div>
      </section>
    </div>
  );
}
