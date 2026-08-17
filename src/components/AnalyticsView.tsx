/**
 * Tenant analytics panel: booking volume, tone/sentiment breakdown, peak
 * booking hours, and AI-agent efficiency. Every chart here is hand-drawn
 * SVG/Tailwind — no charting library — per this turn's "zero heavy chart
 * libraries" constraint.
 *
 * Categorical/sequential colors are the validated palette from the
 * project's dataviz skill (fixed hue *order*, never picked per-category by
 * feel — see the sentiment donut). Booking-volume bars and the efficiency
 * bar use the app's existing violet brand accent instead, since those are
 * single-series magnitude encodings where color isn't carrying identity.
 */
import { Fragment, useEffect, useState } from "react";
import { Bot, Sparkles } from "lucide-react";
import { getDashboardAnalytics } from "../lib/api.js";
import { useToast } from "./Toast.js";
import type { AnalyticsTimeframe, Sentiment, TenantDashboardMetrics } from "../types/index.js";

// Categorical slots 1–4 of the validated palette, in fixed order — assigned
// to Sentiment's declared order (positive, neutral, negative, frustrated),
// not reordered to "look right" per category.
const SENTIMENT_ORDER: Sentiment[] = ["positive", "neutral", "negative", "frustrated"];
const SENTIMENT_COLORS: Record<Sentiment, { light: string; dark: string; label: string }> = {
  positive: { light: "#2a78d6", dark: "#3987e5", label: "Positive" },
  neutral: { light: "#eb6834", dark: "#d95926", label: "Neutral" },
  negative: { light: "#1baf7a", dark: "#199e70", label: "Negative" },
  frustrated: { light: "#eda100", dark: "#c98500", label: "Frustrated" },
};

// Sequential single-hue ramp (blue, 100→700) for the peak-hours heatmap.
const SEQUENTIAL_RAMP = ["#f1f6fd", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

function sequentialColorFor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return SEQUENTIAL_RAMP[0] as string;
  const step = Math.min(SEQUENTIAL_RAMP.length - 1, Math.ceil((value / max) * (SEQUENTIAL_RAMP.length - 1)));
  return SEQUENTIAL_RAMP[step] as string;
}

// ---------------------------------------------------------------------------
// Booking volume bar chart
// ---------------------------------------------------------------------------

function BookingVolumeChart({ dailyStats }: { dailyStats: TenantDashboardMetrics["dailyStats"] }): JSX.Element {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 600;
  const height = 160;
  const padding = 24;
  const max = Math.max(1, ...dailyStats.map((day) => day.totalAppointments));
  const barGap = 4;
  const barWidth = dailyStats.length > 0 ? Math.max(4, (width - padding * 2) / dailyStats.length - barGap) : 0;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Bookings per day">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={1} />
        {dailyStats.map((day, index) => {
          const barHeight = ((height - padding * 2) * day.totalAppointments) / max;
          const x = padding + index * (barWidth + barGap);
          const y = height - padding - barHeight;
          return (
            <rect
              key={day.day}
              x={x}
              y={y}
              width={barWidth}
              height={Math.max(1, barHeight)}
              rx={2}
              className={hoverIndex === index ? "fill-violet-500" : "fill-violet-600 dark:fill-violet-500/80"}
              onMouseEnter={() => {
                setHoverIndex(index);
              }}
              onMouseLeave={() => {
                setHoverIndex(null);
              }}
              // Touch has no hover equivalent — a tap reveals the same
              // tooltip mouse users get on hover (it just doesn't
              // auto-dismiss without a "leave" event; tapping another bar
              // moves it, which is an acceptable touch affordance here).
              onClick={() => {
                setHoverIndex(index);
              }}
            >
              <title>{`${day.day}: ${day.totalAppointments} booking${day.totalAppointments === 1 ? "" : "s"}`}</title>
            </rect>
          );
        })}
      </svg>
      {dailyStats.length === 0 && (
        <p className="absolute inset-0 flex items-center justify-center text-xs text-slate-400 dark:text-slate-500">No bookings in this window.</p>
      )}
      {hoverIndex !== null && dailyStats[hoverIndex] && (
        <div className="pointer-events-none absolute left-2 top-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <span className="font-medium text-slate-700 dark:text-slate-200">{dailyStats[hoverIndex].day}</span>{" "}
          <span className="text-slate-500 dark:text-slate-400">— {dailyStats[hoverIndex].totalAppointments} bookings</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tone & sentiment donut
// ---------------------------------------------------------------------------

function ToneSentimentDonut({ toneDistribution }: { toneDistribution: TenantDashboardMetrics["toneDistribution"] }): JSX.Element {
  const total = SENTIMENT_ORDER.reduce((sum, key) => sum + (toneDistribution.sentiment[key] ?? 0), 0);
  const radius = 60;
  const strokeWidth = 22;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  const segments = SENTIMENT_ORDER.map((key) => {
    const count = toneDistribution.sentiment[key] ?? 0;
    const fraction = total > 0 ? count / total : 0;
    const segment = { key, count, fraction, offset };
    offset += fraction;
    return segment;
  });

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:justify-center">
      <svg viewBox="0 0 160 160" className="h-40 w-40 shrink-0" role="img" aria-label="Client sentiment breakdown">
        <g transform="translate(80,80) rotate(-90)">
          <circle r={radius} fill="none" className="stroke-slate-100 dark:stroke-slate-800" strokeWidth={strokeWidth} />
          {total === 0
            ? null
            : segments.map((segment) =>
                segment.fraction > 0 ? (
                  <circle
                    key={segment.key}
                    r={radius}
                    fill="none"
                    stroke={SENTIMENT_COLORS[segment.key].light}
                    className="dark:hidden"
                    strokeWidth={strokeWidth}
                    strokeDasharray={`${segment.fraction * circumference} ${circumference}`}
                    strokeDashoffset={-segment.offset * circumference}
                  >
                    <title>{`${SENTIMENT_COLORS[segment.key].label}: ${segment.count}`}</title>
                  </circle>
                ) : null,
              )}
          {total === 0
            ? null
            : segments.map((segment) =>
                segment.fraction > 0 ? (
                  <circle
                    key={`${segment.key}-dark`}
                    r={radius}
                    fill="none"
                    stroke={SENTIMENT_COLORS[segment.key].dark}
                    className="hidden dark:inline"
                    strokeWidth={strokeWidth}
                    strokeDasharray={`${segment.fraction * circumference} ${circumference}`}
                    strokeDashoffset={-segment.offset * circumference}
                  >
                    <title>{`${SENTIMENT_COLORS[segment.key].label}: ${segment.count}`}</title>
                  </circle>
                ) : null,
              )}
        </g>
        <text x={80} y={76} textAnchor="middle" className="fill-slate-900 text-2xl font-semibold dark:fill-slate-50">
          {total}
        </text>
        <text x={80} y={94} textAnchor="middle" className="fill-slate-400 text-[10px] dark:fill-slate-500">
          interactions
        </text>
      </svg>
      <ul className="space-y-1.5 text-sm">
        {SENTIMENT_ORDER.map((key) => (
          <li key={key} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: SENTIMENT_COLORS[key].light }}
            />
            <span className="text-slate-600 dark:text-slate-300">{SENTIMENT_COLORS[key].label}</span>
            <span className="tabular-nums text-slate-400 dark:text-slate-500">{toneDistribution.sentiment[key] ?? 0}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Peak hours heatmap
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_LABELS = [0, 3, 6, 9, 12, 15, 18, 21];

function PeakHoursHeatmap({ heatmap }: { heatmap: number[][] }): JSX.Element {
  const max = Math.max(1, ...heatmap.flat());

  return (
    <div className="overflow-x-auto">
      <div className="inline-grid min-w-full grid-cols-[2.5rem_repeat(24,minmax(0.85rem,1fr))] gap-[2px]">
        <div />
        {Array.from({ length: 24 }, (_, hour) => (
          <div key={hour} className="text-center text-[9px] text-slate-400 dark:text-slate-500">
            {HOUR_LABELS.includes(hour) ? hour : ""}
          </div>
        ))}
        {heatmap.map((row, dayIndex) => (
          <Fragment key={dayIndex}>
            <div className="flex items-center text-[10px] text-slate-500 dark:text-slate-400">{WEEKDAY_LABELS[dayIndex]}</div>
            {row.map((count, hour) => (
              <div
                key={hour}
                className="aspect-square rounded-[2px]"
                style={{ backgroundColor: sequentialColorFor(count, max) }}
                title={`${WEEKDAY_LABELS[dayIndex]} ${hour}:00 — ${count} booking${count === 1 ? "" : "s"}`}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI agent efficiency stat
// ---------------------------------------------------------------------------

function AiEfficiencyStat({ metrics }: { metrics: TenantDashboardMetrics }): JSX.Element {
  const staffBookings = metrics.bookingsByChannel.staff_manual ?? 0;
  const aiBookings = (metrics.bookingsByChannel.ai_chat ?? 0) + (metrics.bookingsByChannel.ai_voice ?? 0);

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <Bot className="h-5 w-5 text-violet-600 dark:text-violet-400" />
        <span className="text-3xl font-semibold text-slate-900 dark:text-slate-50">{metrics.aiAgentEfficiencyPct}%</span>
        <span className="text-xs text-slate-400 dark:text-slate-500">of bookings completed without staff</span>
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className="h-full rounded-full bg-violet-600 dark:bg-violet-500" style={{ width: `${metrics.aiAgentEfficiencyPct}%` }} />
      </div>
      <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
        {aiBookings} AI-completed · {staffBookings} staff-booked
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const TIMEFRAMES: { value: AnalyticsTimeframe; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
];

export default function AnalyticsView({ tenantId }: { tenantId: string }): JSX.Element {
  const { showToast } = useToast();
  const [timeframe, setTimeframe] = useState<AnalyticsTimeframe>("30d");
  const [metrics, setMetrics] = useState<TenantDashboardMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!tenantId.trim()) {
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    getDashboardAnalytics(tenantId, timeframe)
      .then((result) => {
        if (!cancelled) setMetrics(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) showToast(error instanceof Error ? error.message : "Failed to load analytics.", "error");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, timeframe, showToast]);

  if (!tenantId.trim()) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        Enter a tenant id in the header to load analytics.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-slate-900 dark:text-slate-50">
          <Sparkles className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          <h2 className="text-lg font-semibold">Analytics</h2>
        </div>
        <div className="flex gap-1 rounded-lg border border-slate-200 p-0.5 dark:border-slate-800">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.value}
              type="button"
              onClick={() => {
                setTimeframe(tf.value);
              }}
              className={`min-h-12 rounded-md px-3 text-xs font-medium transition active:scale-95 sm:min-h-0 sm:px-2.5 sm:py-1 ${
                timeframe === tf.value
                  ? "bg-violet-600 text-white"
                  : "text-slate-500 active:bg-slate-100 dark:text-slate-400 dark:active:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>

      {!metrics ? (
        <p className="text-xs text-slate-400 dark:text-slate-500">{isLoading ? "Loading…" : "No data."}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Booking volume</h3>
            <BookingVolumeChart dailyStats={metrics.dailyStats} />
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Tone &amp; sentiment</h3>
            <ToneSentimentDonut toneDistribution={metrics.toneDistribution} />
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 lg:col-span-2">
            <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Peak booking hours</h3>
            <PeakHoursHeatmap heatmap={metrics.bookingHeatmap} />
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">AI agent efficiency</h3>
            <AiEfficiencyStat metrics={metrics} />
          </div>

          <div className="grid grid-cols-2 gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div>
              <p className="text-xs text-slate-400 dark:text-slate-500">Cancellation rate</p>
              <p className="text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.cancellationRatePct}%</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 dark:text-slate-500">Slot utilization</p>
              <p className="text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.slotUtilizationRatePct}%</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 dark:text-slate-500">Client retention</p>
              <p className="text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.clientRetentionRatePct}%</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 dark:text-slate-500">Total bookings</p>
              <p className="text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.totalAppointments}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
