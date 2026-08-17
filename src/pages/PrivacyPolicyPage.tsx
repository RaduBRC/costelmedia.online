/**
 * /privacy — written to reflect what this codebase actually does (data
 * collected, actual third-party processors, actual Google Calendar OAuth
 * scope), not generic boilerplate. Still: this is a starting draft, not
 * legal advice — see the callout at the top of the page itself, and the
 * conversation this shipped in for why that matters before submitting it
 * anywhere for real (Google OAuth verification, Stripe underwriting).
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

export default function PrivacyPolicyPage(): JSX.Element {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="mb-8 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
        This page describes, accurately, what the CostelMedia platform actually collects and does with data today. It is a starting draft, not
        legal advice — have it reviewed by counsel before relying on it for Google OAuth verification, Stripe underwriting, or any other
        compliance submission.
      </div>

      <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Privacy Policy</h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Last updated: {LAST_UPDATED}</p>

      <div className="mt-10 space-y-10">
        <Section title="1. Who we are">
          <p>
            CostelMedia ("CostelMedia", "we", "us") operates an AI-powered scheduling platform: businesses ("Tenants") use it to let an AI voice
            and chat agent answer calls and messages from their own customers ("Clients") and book appointments on their behalf. This policy
            covers both Tenants (businesses with a CostelMedia account) and Clients (the people who call, message, or chat with a Tenant's AI
            agent).
          </p>
        </Section>

        <Section title="2. Information we collect">
          <p>We collect only what's needed to operate the booking service:</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li><strong>Tenant account data:</strong> business name, address, phone number, working hours, staff login emails.</li>
            <li><strong>Client data:</strong> phone number, name (if given), and appointment history — collected by the Tenant's AI agent during a booking conversation.</li>
            <li><strong>Conversation content:</strong> the text or voice transcript of conversations between Clients and the AI agent, so the agent can carry out and confirm bookings.</li>
            <li><strong>Appointment records:</strong> service requested, date/time, and status.</li>
            <li><strong>Security logs:</strong> message content and the originating IP address for messages our automated abuse-detection system flags, kept as an audit trail.</li>
            <li><strong>Device tokens</strong> for push notifications, only if a Tenant's staff member opts into them.</li>
          </ul>
        </Section>

        <Section title="3. How we use information">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>To operate the AI agent: understanding a request, checking availability, and creating, changing, or cancelling a booking.</li>
            <li>To adapt the AI's tone and responses to a Tenant's configured business type, persona, and FAQs.</li>
            <li>To detect and block abusive or malicious input before it reaches the AI.</li>
            <li>To send appointment reminders and, if enabled, push notifications.</li>
          </ul>
          <p>We do not sell personal data, and we do not use Client conversation data to train third-party AI models beyond the standard processing needed to generate that conversation's own reply.</p>
        </Section>

        <Section title="4. Google Calendar data">
          <p>
            If a Tenant connects their own Google account, CostelMedia requests the <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800">https://www.googleapis.com/auth/calendar</code> scope
            — read and write access to that Tenant's calendar. We use it strictly to:
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>check whether a requested time slot is free (free/busy lookups), and</li>
            <li>create, update, or delete calendar events for bookings made through the AI agent.</li>
          </ul>
          <p>
            We do not read calendar data for any other purpose, do not share it with third parties, and do not sell it. A Tenant can revoke this
            access at any time from their Settings page or directly from their Google Account permissions — booking continues to work afterward
            using the Tenant's own working hours and existing appointment records instead.
          </p>
          <p>
            CostelMedia's use and transfer of information received from Google APIs adheres to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noreferrer"
              className="text-violet-600 underline dark:text-violet-400"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </p>
        </Section>

        <Section title="5. Other services we rely on">
          <p>To provide the service, data is processed by these subprocessors, each under their own terms:</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li><strong>Supabase</strong> — database, authentication, and file storage.</li>
            <li><strong>Groq</strong> — processes conversation text to generate the AI agent's replies.</li>
            <li><strong>ElevenLabs</strong> — converts the AI's text replies to spoken audio.</li>
            <li><strong>Deepgram</strong> — transcribes spoken audio to text on live phone calls, where configured.</li>
            <li><strong>Twilio</strong> — carries phone calls, SMS, and WhatsApp messages, where configured.</li>
            <li><strong>Google</strong> — calendar sync, where a Tenant connects it.</li>
          </ul>
          <p>None of these providers are permitted to use the data for their own advertising purposes.</p>
        </Section>

        <Section title="6. Cookies and local storage">
          <p>
            The CostelMedia dashboard uses your browser's local/session storage to keep you signed in — not third-party advertising or tracking
            cookies. Choosing "Remember me" at login stores your session in a way that survives closing the tab; leaving it unchecked keeps you
            signed in only until you close the tab. We don't currently use any third-party analytics or ad-tracking cookies on the dashboard or
            marketing site.
          </p>
        </Section>

        <Section title="7. Data retention and deletion">
          <p>
            We retain Tenant and Client data for as long as the Tenant's account is active, or as needed to provide the service, comply with
            legal obligations, and resolve disputes. A Tenant can delete individual appointments, services, or FAQs at any time from their
            dashboard. To request deletion of your data entirely, contact us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-violet-600 underline dark:text-violet-400">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>

        <Section title="8. Your rights">
          <p>
            Depending on where you live, you may have the right to access, correct, export, or delete your personal data. To exercise any of
            these rights, contact us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-violet-600 underline dark:text-violet-400">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>

        <Section title="9. Children's privacy">
          <p>CostelMedia is a business scheduling tool and is not directed at, or knowingly used to collect data from, children.</p>
        </Section>

        <Section title="10. Changes to this policy">
          <p>We'll update the "Last updated" date above when this policy changes, and post the updated version on this page.</p>
        </Section>

        <Section title="11. Contact">
          <p>
            Questions about this policy or your data:{" "}
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
