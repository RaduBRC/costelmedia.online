/**
 * /terms — same honesty constraint as PrivacyPolicyPage.tsx: no invented
 * SLA numbers or guarantees this platform doesn't actually back with real
 * infrastructure (no uptime monitoring/SLA credits system exists), and no
 * pretending self-service Stripe billing exists yet when it doesn't — see
 * this page's own callout, and the conversation this shipped in.
 */
import { Link } from "react-router-dom";

const CONTACT_EMAIL = "contact@costelmedia.online";
const LAST_UPDATED = "August 17, 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">{children}</div>
    </section>
  );
}

export default function TermsOfServicePage(): JSX.Element {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="mb-8 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
        This is a starting draft, not legal advice — have it reviewed by counsel (and fill in your actual governing-law jurisdiction and legal
        entity name below) before relying on it for real subscriptions, Stripe underwriting, or any other compliance submission.
      </div>

      <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Terms of Service</h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Last updated: {LAST_UPDATED}</p>

      <div className="mt-10 space-y-10">
        <Section title="1. Agreement">
          <p>
            These Terms govern access to and use of the CostelMedia platform (the "Service"), operated by CostelMedia ("we", "us"). By creating
            an account or using the Service, you agree to these Terms. If you're using the Service on behalf of a business, you're confirming
            you have authority to bind that business to these Terms.
          </p>
        </Section>

        <Section title="2. The Service">
          <p>
            CostelMedia provides an AI voice and chat agent that answers calls and messages on your behalf and books appointments into your
            calendar, along with a dashboard to configure your business's services, hours, AI persona, and view bookings and call activity.
          </p>
        </Section>

        <Section title="3. Accounts">
          <p>
            You're responsible for keeping your account credentials secure and for all activity under your account. Tell us immediately at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-violet-600 underline dark:text-violet-400">
              {CONTACT_EMAIL}
            </a>{" "}
            if you suspect unauthorized access.
          </p>
        </Section>

        <Section title="4. Subscriptions and billing">
          <p>
            The Service is offered on the subscription plans published on our pricing page, billed monthly unless otherwise agreed in writing.
            Plans include a stated monthly allowance of AI conversation minutes; usage beyond that allowance may be billed separately or require
            an upgrade, as described on the pricing page at the time.
          </p>
          <p>
            Self-service online checkout is not live yet — subscriptions are currently set up directly with our team. Once online billing (via
            Stripe) is available, this section will describe payment processing, automatic renewal, and cancellation through the dashboard.
          </p>
          <p>You may cancel at any time by contacting us; cancellation takes effect at the end of the current billing period unless we agree otherwise.</p>
        </Section>

        <Section title="5. Acceptable use">
          <p>You agree not to use the Service to:</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>send unlawful, abusive, or fraudulent communications through the AI agent;</li>
            <li>attempt to bypass or manipulate the AI agent's safety rules or the security guardrail;</li>
            <li>collect personal data from Clients beyond what's needed to provide your own service to them; or</li>
            <li>reverse-engineer, resell, or white-label the Service without our written agreement.</li>
          </ul>
        </Section>

        <Section title="6. Service availability">
          <p>
            We work to keep the Service reliably available and will make commercially reasonable efforts to communicate planned maintenance and
            resolve outages promptly. The Service is provided without a guaranteed uptime percentage or service-level credits at this time — if
            we introduce a formal SLA for a given plan, it will be stated on that plan's pricing details.
          </p>
        </Section>

        <Section title="7. Third-party services">
          <p>
            The Service relies on third-party providers (calendar sync, telephony, speech, and AI inference — see our{" "}
            <Link to="/privacy" className="text-violet-600 underline dark:text-violet-400">
              Privacy Policy
            </Link>{" "}
            for the current list) to function. We're not responsible for outages or changes on those providers' end, though we'll work to
            minimize their impact on you.
          </p>
        </Section>

        <Section title="8. Disclaimer of warranties">
          <p>
            The Service is provided "as is" and "as available," without warranties of any kind, express or implied, including merchantability,
            fitness for a particular purpose, and non-infringement. We don't warrant that the Service will be error-free or uninterrupted, or
            that the AI agent's responses will always be accurate — you're responsible for reviewing bookings and configuring the AI's rules and
            FAQs appropriately for your business.
          </p>
        </Section>

        <Section title="9. Limitation of liability">
          <p>
            To the maximum extent permitted by law, CostelMedia will not be liable for any indirect, incidental, special, consequential, or
            punitive damages, or for any loss of profits, revenue, data, or business opportunity, arising from your use of the Service. Our
            total liability for any claim arising from these Terms or the Service is limited to the amount you paid us in the three months
            before the claim arose.
          </p>
        </Section>

        <Section title="10. Termination">
          <p>
            You may stop using the Service and close your account at any time. We may suspend or terminate an account that violates these Terms,
            with notice where practical.
          </p>
        </Section>

        <Section title="11. Changes to these Terms">
          <p>We'll update the "Last updated" date above when these Terms change, and post the updated version on this page.</p>
        </Section>

        <Section title="12. Governing law">
          <p>[Governing-law jurisdiction to be confirmed with counsel before publishing.]</p>
        </Section>

        <Section title="13. Contact">
          <p>
            Questions about these Terms:{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-violet-600 underline dark:text-violet-400">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>
      </div>

      <Link to="/" className="mt-12 inline-block text-sm font-medium text-violet-600 hover:underline dark:text-violet-400">
        ← Back to home
      </Link>
    </div>
  );
}
