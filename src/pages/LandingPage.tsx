/**
 * Public marketing homepage (/) for costelmedia.online. Deliberately has
 * no fabricated stats, testimonials, or customer logos — this is a real
 * new product with no live customers yet, and inventing social proof
 * would be actively dishonest marketing copy, not just an aggressive
 * sales page. Every feature claim here maps to something actually built
 * in this codebase, not aspirational copy.
 *
 * This page commits to its own dark "audio-signal" visual world (see
 * LandingPage.css) rather than following the site's normal light/dark
 * theme toggle — a deliberate choice for a one-page cinematic marketing
 * surface, discussed and approved directly with Radu. Because of that it
 * renders its own nav + footer (below) instead of the shared
 * PublicNav/Footer used by /privacy and /terms, which keep the standard
 * site chrome. It is intentionally NOT nested under <PublicLayout/> in
 * App.tsx for the same reason.
 */
import { useEffect, useRef, useState } from "react";
import {
  Briefcase,
  Building2,
  CalendarCheck,
  Car,
  Check,
  Gavel,
  Globe2,
  HeartPulse,
  LogOut,
  Menu,
  Mic,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";
import "./LandingPage.css";

const CONTACT_EMAIL = "contact@costelmedia.online";

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

// Live-transcript demo script, shown looping in the hero. Romanian, matching
// what a real caller would actually say to this product's AI voice agent.
const DEMO_SCRIPT: Array<{ who: "caller" | "ai"; text: string }> = [
  { who: "caller", text: "Buna ziua, as vrea o programare maine dupa-amiaza." },
  { who: "ai", text: "Sigur — am liber maine la 14:00 sau 16:30. Care va convine?" },
  { who: "caller", text: "16:30 e perfect." },
  { who: "ai", text: "Notat pentru 16:30 maine. Va astept cu placere!" },
];

// Scattered "missed call" notifications for the scroll-story's chaos phase.
const STORY_CHIP_TEXT = [
  "Missed Call · 2:14 PM",
  "No answer after 6 rings",
  "Voicemail (unheard)",
  "Booking request — abandoned",
  "Client called competitor",
  "3 missed calls today",
  "“nobody picked up”",
  "Follow-up needed",
  "Lead gone cold",
  "Slot never confirmed",
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}
type RGB = [number, number, number];
function lerpColor(c1: RGB, c2: RGB, t: number): RGB {
  return [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))];
}
// Triangular visibility curve: rises from `start` over `riseSpan`, holds,
// falls to 0 by `end` over `fallSpan`. Reused for whole-line chrome and,
// with a per-word delayed `start`, for headline words flying in one after
// another instead of appearing as one block.
function triLocal(p: number, start: number, end: number, riseSpan: number, fallSpan: number): number {
  if (p <= start || p >= end) return 0;
  const riseT = riseSpan > 0 ? clamp01((p - start) / riseSpan) : 1;
  const fallT = fallSpan > 0 ? clamp01((end - p) / fallSpan) : 1;
  return Math.min(riseT, fallT);
}
// Splits a headline's HTML into per-word <span class="word"> wrappers so
// each word can fly toward the viewer independently. Idempotent — safe to
// call twice (React StrictMode double-invokes effects in dev) because it
// reuses existing .word spans instead of re-wrapping already-wrapped text.
function wrapWords(el: HTMLElement): HTMLElement[] {
  const existing = el.querySelectorAll<HTMLElement>(".word");
  if (existing.length > 0) return Array.from(existing);
  const tokens = el.innerHTML.split(" ");
  el.innerHTML = "";
  const words: HTMLElement[] = [];
  tokens.forEach((tok, idx) => {
    if (tok.trim() === "") return;
    const span = document.createElement("span");
    span.className = "word";
    span.innerHTML = tok;
    el.appendChild(span);
    words.push(span);
    if (idx < tokens.length - 1) el.appendChild(document.createTextNode(" "));
  });
  return words;
}

const ALERT_RGB: RGB = [255, 106, 92];
const CALM_RGB: RGB = [139, 107, 255];
const CALM2_RGB: RGB = [53, 231, 200];

export default function LandingPage(): JSX.Element {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const primaryCtaHref = session ? "/admin/dashboard" : "/login";
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = (): void => {
    setMobileMenuOpen(false);
    logout()
      .then(() => navigate("/", { replace: true }))
      .catch(() => {
        // Best-effort — supabase.auth.signOut() failing here (e.g. offline)
        // still clears local session state via onAuthStateChange, so
        // there's nothing actionable to surface on this public page.
      });
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const storyWrapperRef = useRef<HTMLElement>(null);
  const storySceneRef = useRef<HTMLDivElement>(null);
  const storyCanvasRef = useRef<HTMLCanvasElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const demoBodyRef = useRef<HTMLDivElement>(null);
  const progressBarRef = useRef<HTMLSpanElement>(null);
  const progressLabelRef = useRef<HTMLSpanElement>(null);
  const line1Ref = useRef<HTMLDivElement>(null);
  const line2Ref = useRef<HTMLDivElement>(null);
  const line3Ref = useRef<HTMLDivElement>(null);
  const fixChip1Ref = useRef<HTMLDivElement>(null);
  const fixChip2Ref = useRef<HTMLDivElement>(null);

  // ---------- scrollytelling story (chaos -> calm) ----------
  useEffect(() => {
    const wrapper = storyWrapperRef.current;
    const scene = storySceneRef.current;
    const canvas = storyCanvasRef.current;
    const progressBar = progressBarRef.current;
    const progressLabel = progressLabelRef.current;
    if (!wrapper || !scene || !canvas || !progressBar || !progressLabel) return undefined;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return undefined;

    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize(): void {
      if (!canvas) return;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
    }
    resize();
    window.addEventListener("resize", resize);

    const isSmallScreen = window.innerWidth < 640;
    const chipList = isSmallScreen ? STORY_CHIP_TEXT.slice(0, 6) : STORY_CHIP_TEXT;
    const createdChips = chipList.map((text) => {
      const el = document.createElement("div");
      el.className = "chip";
      el.textContent = text;
      scene.appendChild(el);
      return el;
    });
    const chips = createdChips.map((el) => ({
      el,
      seed: Math.random() * Math.PI * 2,
      speed: 0.4 + Math.random() * 0.6,
      depth: Math.random(),
      baseX: 12 + Math.random() * 76,
      baseY: 14 + Math.random() * 62,
      ampX: 3 + Math.random() * 5,
      ampY: 3 + Math.random() * 5,
    }));

    const PARTICLES = isSmallScreen ? 45 : 90;
    const particles = Array.from({ length: PARTICLES }, (_, i) => ({
      i,
      seed: Math.random() * Math.PI * 2,
      speed: 0.5 + Math.random() * 1.2,
      scatterX: Math.random(),
      scatterY: Math.random(),
    }));

    const lineEls = [line1Ref.current, line2Ref.current, line3Ref.current].filter(
      (el): el is HTMLDivElement => el !== null,
    );
    const lines = lineEls.map((line) => {
      line.style.opacity = "1"; // children now own real visibility
      const h2 = line.querySelector<HTMLElement>("h2");
      return {
        el: line,
        range: (line.dataset["range"] ?? "0,1").split(",").map(Number) as [number, number],
        eyebrow: line.querySelector<HTMLElement>(".story-eyebrow"),
        p: line.querySelector<HTMLElement>("p"),
        words: h2 ? wrapWords(h2) : [],
      };
    });

    const fixChipEls = [fixChip1Ref.current, fixChip2Ref.current].filter((el): el is HTMLDivElement => el !== null);
    const fixChips = fixChipEls.map((el) => ({
      el,
      before: el.querySelector<HTMLElement>(".before"),
      after: el.querySelector<HTMLElement>(".after"),
      flip: parseFloat(el.dataset["flip"] ?? "0.6"),
      seed: Math.random() * Math.PI * 2,
    }));

    let progress = 0;
    let targetProgress = 0;

    function computeProgress(): void {
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      targetProgress = clamp01(-rect.top / Math.max(total, 1));
    }
    window.addEventListener("scroll", computeProgress, { passive: true });
    computeProgress();

    function drawParticles(t: number, p: number): void {
      if (!canvas || !ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const eased = easeInOut(p);
      for (const particle of particles) {
        const jitterAmt = 1 - eased;
        const jx = Math.sin(t * 0.0009 * particle.speed + particle.seed) * 40 * jitterAmt;
        const jy = Math.cos(t * 0.0011 * particle.speed + particle.seed) * 40 * jitterAmt;
        const scatterPx = particle.scatterX * w;
        const scatterPy = particle.scatterY * h * 0.85 + h * 0.05;
        const targetXNorm = particle.i / PARTICLES;
        const targetPx = targetXNorm * w;
        const envelope = Math.sin(targetXNorm * Math.PI);
        const targetPy = h * 0.72 - envelope * h * 0.16;
        const x = lerp(scatterPx, targetPx, eased) + jx;
        const y = lerp(scatterPy, targetPy, eased) + jy;
        const color = p < 0.5 ? lerpColor(ALERT_RGB, CALM_RGB, p * 2) : lerpColor(CALM_RGB, CALM2_RGB, (p - 0.5) * 2);
        const r = (1.2 + envelope * 1.4) * dpr;
        ctx.beginPath();
        ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${0.25 + eased * 0.5})`;
        ctx.shadowColor = `rgba(${color[0]},${color[1]},${color[2]},0.5)`;
        ctx.shadowBlur = 6 * dpr;
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function updateChips(t: number, p: number): void {
      const eased = easeInOut(p);
      const fadeIn = clamp01(p / 0.14);
      const fadeOut = 1 - clamp01((p - 0.78) / 0.22);
      const opacity = Math.min(fadeIn, fadeOut);
      for (const c of chips) {
        const jitterAmt = 1 - eased;
        const jx = Math.sin(t * 0.0007 * c.speed + c.seed) * c.ampX * jitterAmt;
        const jy = Math.cos(t * 0.0009 * c.speed + c.seed) * c.ampY * jitterAmt;
        const x = lerp(c.baseX, 50, eased * 0.9) + jx;
        const y = lerp(c.baseY, 76, eased * 0.9) + jy;
        const rot = Math.sin(t * 0.0005 + c.seed) * 8 * jitterAmt;
        const tz = (c.depth - 0.5) * 160 * jitterAmt;
        c.el.style.setProperty("--x", `${x}%`);
        c.el.style.setProperty("--y", `${y}%`);
        c.el.style.opacity = String(opacity);
        c.el.style.transform = `translate3d(-50%, -50%, ${tz}px) rotate(${rot}deg) scale(${lerp(1, 0.6, eased)})`;
        const col = lerpColor(ALERT_RGB, CALM2_RGB, eased);
        c.el.style.borderColor = `rgba(${col[0]},${col[1]},${col[2]},0.7)`;
        c.el.style.color = `rgba(${col[0]},${col[1]},${col[2]},1)`;
      }
    }

    function updateLines(p: number): void {
      for (const line of lines) {
        const [start, end] = line.range;
        const span = end - start;
        const fall = span * 0.22;
        const localWhole = triLocal(p, start, end, fall, fall);

        if (line.eyebrow) {
          line.eyebrow.style.opacity = String(localWhole);
          line.eyebrow.style.transform = `translateY(${(1 - localWhole) * 10}px)`;
        }
        if (line.p) {
          line.p.style.opacity = String(localWhole);
          line.p.style.transform = `translateY(${(1 - localWhole) * 10}px)`;
        }

        const wordCount = line.words.length;
        if (!wordCount) continue;
        const riseBudget = Math.min(fall, span * 0.55);
        const wordDelay = wordCount > 1 ? riseBudget / wordCount : 0;
        line.words.forEach((w, i) => {
          const wStart = start + i * wordDelay;
          const local = triLocal(p, wStart, end, fall, fall);
          const z = lerp(-640, 0, local);
          const scale = lerp(0.55, 1, local);
          const blur = lerp(6, 0, local);
          w.style.opacity = String(local);
          w.style.transform = `translateZ(${z.toFixed(1)}px) scale(${scale.toFixed(3)})`;
          w.style.filter = `blur(${blur.toFixed(2)}px)`;
        });
      }
    }

    function updateFixChips(t: number, p: number): void {
      const envIn = clamp01((p - 0.36) / 0.12);
      const envOut = 1 - clamp01((p - 0.9) / 0.08);
      const env = Math.min(envIn, envOut);
      for (const c of fixChips) {
        if (!c.before || !c.after) continue;
        const beforeOp = clamp01((c.flip - p) / 0.1 + 0.5);
        const afterOp = 1 - beforeOp;
        c.before.style.opacity = String(beforeOp * env);
        c.after.style.opacity = String(afterOp * env);
        const floatY = Math.sin(t * 0.001 + c.seed) * 5;
        const tz = lerp(-140, 0, env);
        c.el.style.transform = `translate3d(-50%, -50%, ${tz.toFixed(1)}px) translateY(${floatY.toFixed(1)}px)`;
      }
    }

    function updateProgressUI(p: number): void {
      if (!progressBar || !progressLabel) return;
      progressBar.style.width = `${(p * 100).toFixed(1)}%`;
      progressLabel.textContent = p < 0.32 ? "SIGNAL LOST" : p < 0.66 ? "SEARCHING…" : "SIGNAL LOCKED";
    }

    let rafId = 0;
    function frame(t: number): void {
      progress = lerp(progress, targetProgress, 0.12);
      drawParticles(t, progress);
      updateChips(t, progress);
      updateLines(progress);
      updateFixChips(t, progress);
      updateProgressUI(progress);
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", computeProgress);
      createdChips.forEach((el) => el.remove());
    };
  }, []);

  // ---------- ambient hero waveform ----------
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize(): void {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    }
    resize();
    window.addEventListener("resize", resize);

    const BARS = 64;
    const seeds = Array.from({ length: BARS }, () => Math.random() * Math.PI * 2);
    let rafId = 0;

    function draw(t: number): void {
      if (!canvas || !ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const barW = w / BARS;
      for (let i = 0; i < BARS; i++) {
        const phase = reduceMotion ? 0 : t * 0.0016;
        const wobble = Math.sin(phase + (seeds[i] ?? 0)) * 0.5 + 0.5;
        const envelope = Math.sin((i / BARS) * Math.PI);
        const height = Math.max(0.08, wobble * envelope) * h * 0.82;
        const x = i * barW + barW * 0.22;
        const y = (h - height) / 2;
        const mix = i / BARS;
        const r = Math.round(139 + (53 - 139) * mix);
        const g = Math.round(107 + (231 - 107) * mix);
        const b = Math.round(255 + (200 - 255) * mix);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.shadowColor = "rgba(139,107,255,0.35)";
        ctx.shadowBlur = 6;
        ctx.fillRect(x, y, barW * 0.56, height);
      }
      if (!reduceMotion) rafId = requestAnimationFrame(draw);
    }
    rafId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  // ---------- scroll-reveal for section headers/cards ----------
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const els = root.querySelectorAll<HTMLElement>(".reveal");
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // ---------- subtle 3D tilt on feature cards (desktop pointer only) ----------
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || !window.matchMedia("(hover: hover)").matches) return undefined;

    const cards = Array.from(root.querySelectorAll<HTMLElement>(".feature-card"));
    const handlers = cards.map((card) => {
      const onMove = (e: MouseEvent): void => {
        const rect = card.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width - 0.5;
        const py = (e.clientY - rect.top) / rect.height - 0.5;
        card.style.transform = `perspective(900px) rotateX(${py * -8}deg) rotateY(${px * 8}deg) translateY(-4px)`;
      };
      const onLeave = (): void => {
        card.style.transform = "perspective(900px) rotateX(0) rotateY(0)";
      };
      card.addEventListener("mousemove", onMove);
      card.addEventListener("mouseleave", onLeave);
      return { card, onMove, onLeave };
    });

    return () => {
      handlers.forEach(({ card, onMove, onLeave }) => {
        card.removeEventListener("mousemove", onMove);
        card.removeEventListener("mouseleave", onLeave);
      });
    };
  }, []);

  // ---------- looping live-call transcript demo ----------
  useEffect(() => {
    const body = demoBodyRef.current;
    if (!body) return undefined;
    let i = 0;
    let cancelled = false;
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    function typingIndicator(): HTMLDivElement {
      const d = document.createElement("div");
      d.className = "typing-dots";
      d.innerHTML = "<span></span><span></span><span></span>";
      return d;
    }

    function step(): void {
      if (cancelled || !body) return;
      if (i >= DEMO_SCRIPT.length) {
        timeouts.push(
          setTimeout(() => {
            if (cancelled || !body) return;
            body.innerHTML = "";
            i = 0;
            step();
          }, 2200),
        );
        return;
      }
      const msg = DEMO_SCRIPT[i];
      if (!msg) return;
      const indicator = typingIndicator();
      body.appendChild(indicator);
      body.scrollTop = body.scrollHeight;
      timeouts.push(
        setTimeout(() => {
          if (cancelled || !body) return;
          indicator.remove();
          const bubble = document.createElement("div");
          bubble.className = `bubble ${msg.who === "ai" ? "ai" : "caller"}`;
          bubble.textContent = msg.text;
          body.appendChild(bubble);
          body.scrollTop = body.scrollHeight;
          i++;
          timeouts.push(setTimeout(step, 900));
        }, 700),
      );
    }
    step();

    return () => {
      cancelled = true;
      timeouts.forEach(clearTimeout);
    };
  }, []);

  return (
    <div className="landing-signal" ref={rootRef}>
      <div className="grain" aria-hidden="true" />

      <nav>
        <Link to="/" className="brand">
          <span className="brand-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.4} strokeLinecap="round">
              <path d="M12 3v10M8 7l4-4 4 4" />
              <path d="M5 13a7 7 0 0 0 14 0" />
            </svg>
          </span>
          CostelMedia
        </Link>
        <div className="nav-links">
          <a href="#features">Features</a>
          <a href="#niches">Industries</a>
          <a href="#pricing">Pricing</a>
        </div>
        <div className="nav-cta">
          {session ? (
            <>
              <Link to="/admin/settings" className="btn-ghost">
                Account
              </Link>
              <Link to="/admin/dashboard" className="btn-solid">
                Dashboard
              </Link>
            </>
          ) : (
            <>
              <Link to="/login" className="btn-ghost">
                Log in
              </Link>
              <Link to="/register" className="btn-solid">
                Sign up
              </Link>
            </>
          )}
        </div>
        <button
          type="button"
          className="nav-menu-toggle"
          aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMobileMenuOpen((v) => !v)}
        >
          {mobileMenuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>
      </nav>

      {mobileMenuOpen && (
        <div className="nav-mobile-menu">
          <a href="#features" onClick={() => setMobileMenuOpen(false)}>
            Features
          </a>
          <a href="#niches" onClick={() => setMobileMenuOpen(false)}>
            Industries
          </a>
          <a href="#pricing" onClick={() => setMobileMenuOpen(false)}>
            Pricing
          </a>
          {session ? (
            <>
              <Link to="/admin/settings" onClick={() => setMobileMenuOpen(false)}>
                <SettingsIcon className="mr-2 h-4 w-4" style={{ display: "inline" }} />
                Account
              </Link>
              <Link to="/admin/dashboard" className="btn-solid" onClick={() => setMobileMenuOpen(false)}>
                Dashboard
              </Link>
              <button type="button" onClick={handleLogout}>
                <LogOut className="mr-2 h-4 w-4" style={{ display: "inline" }} />
                Log out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" onClick={() => setMobileMenuOpen(false)}>
                Log in
              </Link>
              <Link to="/register" className="btn-solid" onClick={() => setMobileMenuOpen(false)}>
                Sign up
              </Link>
            </>
          )}
        </div>
      )}

      {/* Scroll-driven story: the caller's frustration (missed calls, no
          answer) resolving into calm right as the real product hero
          appears below it. Skipped entirely under prefers-reduced-motion
          (see the effect above and the CSS media query in LandingPage.css). */}
      <section className="story" ref={storyWrapperRef}>
        <div className="story-stage">
          <canvas className="story-canvas" ref={storyCanvasRef} />
          <div className="story-scene" ref={storySceneRef}>
            <div className="fix-chip fix-chip-1" data-flip="0.56" ref={fixChip1Ref}>
              <span className="before">❌ Booking failed</span>
              <span className="after">✅ Here&apos;s the solution</span>
            </div>
            <div className="fix-chip fix-chip-2" data-flip="0.74" ref={fixChip2Ref}>
              <span className="before">🌙 Can&apos;t book after hours</span>
              <span className="after">🤖 Now you can — 24/7</span>
            </div>
          </div>
          <div className="story-vignette" />
          <div className="story-copy">
            <div className="story-line" data-range="0,0.32" ref={line1Ref}>
              <span className="story-eyebrow">// the problem</span>
              <h2>Every call your team can&apos;t take is a booking someone else takes.</h2>
            </div>
            <div className="story-line" data-range="0.30,0.66" ref={line2Ref}>
              <span className="story-eyebrow">// the cost</span>
              <h2>Missed call. Missed appointment.</h2>
              <p>By the time anyone calls back, the client already booked with your competitor.</p>
            </div>
            <div className="story-line calm" data-range="0.64,1" ref={line3Ref}>
              <span className="story-eyebrow">// the fix</span>
              <h2>Until something finally answers.</h2>
              <p>Every call, every chat, every time — instantly.</p>
            </div>
          </div>
          <div className="story-progress">
            <span ref={progressLabelRef}>SIGNAL LOST</span>
            <span className="story-progress-track">
              <span className="story-progress-bar" ref={progressBarRef} />
            </span>
          </div>
        </div>
      </section>

      {/* Hero */}
      <section className="hero">
        <div className="hero-glow" />
        <div className="eyebrow">
          <span className="live-dot" /> AI VOICE &amp; CHAT RECEPTIONIST — LIVE ON EVERY CHANNEL
        </div>
        <h1>
          Never miss a booking again —
          <br />
          <span className="accent">let AI answer, everywhere.</span>
        </h1>
        <p className="lede">
          CostelMedia answers calls, chats, and website messages, checks real availability, and books the appointment
          — for clinics, salons, auto shops, legal practices, and more. Live in minutes, not months.
        </p>
        <div className="hero-actions">
          <Link to={primaryCtaHref} className="btn-primary">
            {session ? "Go to Dashboard" : "Start Free Trial"}
          </Link>
          <Link to={session ? "/admin/tools/voice" : "/login"} className="btn-secondary">
            <Mic className="mic-icon" />
            Try the Live Voice Demo
          </Link>
        </div>
        <p className="hero-hint">
          The live voice demo runs inside your dashboard — sign in (or start a free trial) to try it with your own
          business.
        </p>

        <div className="waveform-wrap">
          <canvas className="waveform-canvas" ref={waveformCanvasRef} />
        </div>

        <div className="demo-panel">
          <div className="demo-head">
            <span>INCOMING_CALL.transcript</span>
            <span className="rec">
              <span className="live-dot" /> LIVE
            </span>
          </div>
          <div className="demo-body" ref={demoBodyRef} />
        </div>
      </section>

      {/* Features */}
      <section id="features">
        <div className="wrap">
          <div className="section-head reveal">
            <span className="tag">[FEATURES]</span>
            <h2>Everything a real receptionist does — automatically</h2>
          </div>
          <div className="features-grid">
            {FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <div key={feature.title} className="feature-card reveal">
                  <div className="feature-icon">
                    <Icon />
                  </div>
                  <h3>{feature.title}</h3>
                  <p>{feature.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Industries / niches */}
      <section id="niches">
        <div className="wrap">
          <div className="section-head reveal">
            <span className="tag">[INDUSTRIES]</span>
            <h2>Built for your industry, not a generic script</h2>
            <p>The AI&apos;s persona, rules, and FAQs adapt to your business type — plus restaurants, call centers, and general service businesses.</p>
          </div>
          <div className="niches-grid">
            {NICHES.map((niche) => {
              const Icon = niche.icon;
              return (
                <div key={niche.label} className="niche-card reveal">
                  <div className="niche-icon">
                    <Icon />
                  </div>
                  <h3>{niche.label}</h3>
                  <p>{niche.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing">
        <div className="wrap">
          <div className="section-head reveal">
            <span className="tag">[PRICING]</span>
            <h2>Simple, transparent pricing</h2>
            <p>Every plan includes unlimited bookings and every industry persona. Cancel anytime.</p>
          </div>
          <div className="pricing-grid">
            {PRICING_TIERS.map((tier) => (
              <div key={tier.name} className={`price-card reveal${tier.highlighted ? " highlight" : ""}`}>
                {tier.highlighted && <span className="price-badge">MOST POPULAR</span>}
                <h3>{tier.name}</h3>
                <p className="tagline">{tier.tagline}</p>
                <p className="price-num">
                  {tier.price}
                  <span>/mo</span>
                </p>
                <ul className="price-list">
                  {tier.features.map((feature) => (
                    <li key={feature}>
                      <Check />
                      {feature}
                    </li>
                  ))}
                </ul>
                {/* Placeholder CTA — not wired to Stripe Checkout yet.
                    Honestly labeled rather than a fake "Subscribe" button
                    that would imply a real charge happens on click. */}
                <Link to="/login" className="price-cta">
                  Get started
                </Link>
              </div>
            ))}
          </div>
          <p className="pricing-note">// online self-service checkout coming soon — our team sets up billing with you directly</p>
        </div>
      </section>

      {/* Final CTA */}
      <section className="final-cta">
        <div className="wrap reveal">
          <div className="ring">
            <Building2 />
          </div>
          <h2>Ready to stop missing bookings?</h2>
          <p>Set up your AI receptionist today — it answers the next call before you finish reading this.</p>
          <div className="hero-actions" style={{ marginTop: "26px" }}>
            <Link to={primaryCtaHref} className="btn-primary">
              <Briefcase className="mic-icon" />
              {session ? "Go to Dashboard" : "Start Free Trial"}
            </Link>
          </div>
        </div>
      </section>

      <footer>
        <div className="footer-inner">
          <div className="footer-top">
            <div className="footer-brand">
              <div className="brand">
                <span className="brand-mark">
                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.4} strokeLinecap="round">
                    <path d="M12 3v10M8 7l4-4 4 4" />
                    <path d="M5 13a7 7 0 0 0 14 0" />
                  </svg>
                </span>
                CostelMedia
              </div>
              <p>AI voice &amp; chat receptionist that books appointments for clinics, salons, auto shops, legal practices, and more.</p>
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </div>
            <div className="footer-links">
              <div className="footer-col">
                <span className="label">Product</span>
                <a href="#features">Features</a>
                <a href="#pricing">Pricing</a>
                <Link to="/login">Login</Link>
                <Link to="/admin/dashboard">Dashboard</Link>
              </div>
              <div className="footer-col">
                <span className="label">Legal</span>
                <Link to="/privacy">Privacy Policy</Link>
                <Link to="/terms">Terms of Service</Link>
              </div>
            </div>
          </div>
          <div className="footer-bottom">© {new Date().getFullYear()} CostelMedia. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
}
