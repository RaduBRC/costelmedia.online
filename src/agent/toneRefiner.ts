/**
 * Client tone learning synchronizer: periodically (or after an
 * appointment, via the cron scheduler) re-derives a client's
 * `communication_style` summary and formality score from their actual
 * interaction history, rather than only ever reflecting the single most
 * recent message.
 */
import { getClientProfileByIdUnscoped, getRecentConversationLogs, refineClientProfile } from "../db/supabase.js";
import type { ConversationLogEntry, FiveScale, Sentiment } from "../types/index.js";

const HISTORY_SAMPLE_SIZE = 5;

const SENTIMENT_SCORE: Record<Sentiment, number> = {
  frustrated: -1,
  negative: 0,
  neutral: 1,
  positive: 2,
};

export type SentimentTrend = "improving" | "declining" | "stable";

export interface ToneRefinementResult {
  clientId: string;
  sampleSize: number;
  averageFormality: FiveScale;
  sentimentTrend: SentimentTrend;
  communicationStyle: string;
}

function clampFiveScale(value: number): FiveScale {
  return Math.min(5, Math.max(1, Math.round(value))) as FiveScale;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * `logs` is newest-first. Compares the average sentiment of the more
 * recent half against the older half to describe a trend — not a
 * statistically rigorous regression, just enough signal to adapt tone.
 */
function computeSentimentTrend(logs: ConversationLogEntry[]): SentimentTrend {
  if (logs.length < 2) {
    return "stable";
  }
  const midpoint = Math.ceil(logs.length / 2);
  const recentHalf = logs.slice(0, midpoint);
  const olderHalf = logs.slice(midpoint);
  if (olderHalf.length === 0) {
    return "stable";
  }

  const recentAvg = average(recentHalf.map((log) => SENTIMENT_SCORE[log.sentiment]));
  const olderAvg = average(olderHalf.map((log) => SENTIMENT_SCORE[log.sentiment]));
  const delta = recentAvg - olderAvg;

  const TREND_THRESHOLD = 0.3;
  if (delta > TREND_THRESHOLD) return "improving";
  if (delta < -TREND_THRESHOLD) return "declining";
  return "stable";
}

function describeFormality(score: FiveScale): string {
  if (score >= 4) return "formal";
  if (score <= 2) return "casual";
  return "neutral";
}

function buildCommunicationStyleSummary(
  averageFormality: FiveScale,
  sentimentTrend: SentimentTrend,
  sampleSize: number,
): string {
  const trendPhrase =
    sentimentTrend === "improving"
      ? "sentiment trending more positive"
      : sentimentTrend === "declining"
        ? "sentiment trending more negative"
        : "sentiment holding steady";
  return `${describeFormality(averageFormality)} (avg formality ${averageFormality}/5), ${trendPhrase} over the last ${sampleSize} interaction${sampleSize === 1 ? "" : "s"}.`;
}

/**
 * Recalculates a client's formality score and communication-style summary
 * from their last 5 logged interactions and persists it. Returns `null`
 * (a no-op) if the client has no logged history yet or doesn't exist.
 */
export async function aggregateClientFeedback(clientId: string): Promise<ToneRefinementResult | null> {
  const clientProfile = await getClientProfileByIdUnscoped(clientId);
  if (!clientProfile) {
    return null;
  }

  const logs = await getRecentConversationLogs(clientId, HISTORY_SAMPLE_SIZE);
  if (logs.length === 0) {
    return null;
  }

  const averageFormality = clampFiveScale(average(logs.map((log) => log.formalityScore)));
  const sentimentTrend = computeSentimentTrend(logs);
  const communicationStyle = buildCommunicationStyleSummary(averageFormality, sentimentTrend, logs.length);

  await refineClientProfile(clientProfile.tenantId, clientId, { formalityScore: averageFormality, communicationStyle });

  return { clientId, sampleSize: logs.length, averageFormality, sentimentTrend, communicationStyle };
}
