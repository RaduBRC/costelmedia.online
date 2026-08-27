/**
 * The Twilio Media Streams WebSocket endpoint (`/api/v1/voice/stream`,
 * opened by the `<Connect><Stream>` TwiML from voiceHandler.ts). One
 * connection per call; each connection's handlers close entirely over
 * their own local state (`streamSid`, the Deepgram handle, the in-progress
 * utterance buffer) — nothing here is shared across calls, so concurrent
 * calls can't race each other.
 *
 * Latency budget for the < 800ms round-trip target: Deepgram's
 * `endpointing=300ms` is the turn-detection delay, Groq's completion is
 * typically 200–500ms on their LPU inference, and ElevenLabs' `/stream`
 * endpoint starts returning audio before synthesis finishes. Outbound
 * audio (the agent's own replies) is still forwarded chunk-by-chunk, never
 * buffered — but INBOUND audio (the caller's speech) is now buffered for
 * the duration of one utterance (onSpeechStarted to onUtteranceEnd) so it
 * can be handed to Whisper (whisperStt.ts) as a complete clip once
 * Deepgram signals the turn is over — see onUtteranceEnd below for why
 * that's a deliberate latency/accuracy tradeoff, not an oversight.
 */
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { processClientMessage } from "../agent/groqAgent.js";
import { getVoiceGreeting } from "../agent/promptBuilder.js";
import { getTenantById, insertServiceFailure, insertUsageEvent, insertVoiceCallMetric, listServices } from "../db/supabase.js";
import {
  appendTranscriptTurn,
  beginAgentSpeech,
  createCallSession,
  endAgentSpeech,
  endCallSession,
  getCallSession,
  interruptAgentSpeech,
  recordBookingOutcome,
  recordToneSignal,
} from "./callSession.js";
import { openDeepgramStream } from "./deepgramStt.js";
import type { DeepgramStreamHandle } from "./deepgramStt.js";
import {
  describeElevenLabsStatus,
  ElevenLabsNotConfiguredError,
  ElevenLabsRequestError,
  ElevenLabsTimeoutError,
  streamTextToSpeech,
} from "./elevenLabsTts.js";
import { rawDataToUtf8String } from "./rawData.js";
import { transcribeWithWhisper } from "./whisperStt.js";
import type { ConversationTurn, Service, Tenant } from "../types/index.js";
import { evaluateThreat, GENERIC_BLOCKED_REPLY } from "../security/threatSentinel.js";

/** Appended to the reply on the turn a call crosses the sustained-frustration threshold (callSession.ts's recordToneSignal) — offers a human follow-up without ending the call outright, since the caller may still want to keep going. */
const ESCALATION_OFFER_MESSAGE =
  "Îmi pare rău că nu v-am putut ajuta atât de repede pe cât aș fi vrut — am notat solicitarea dumneavoastră și un coleg vă va contacta în cel mai scurt timp.";

const VOICE_STREAM_PATH = "/api/v1/voice/stream";
// Fallback only for the edge case where the tenant lookup itself fails
// (e.g. the row was deleted mid-call) — getVoiceGreeting's business-type
// variants (promptBuilder.ts) are what plays under normal operation.
const DEFAULT_VOICE_GREETING = "Bună ziua! Bine ați venit. Cu ce vă pot ajuta astăzi?";

// ---------------------------------------------------------------------------
// Connection rate limiting
//
// This WebSocket endpoint is attached via the raw `upgrade` event
// (`{ noServer: true }`, see attachVoiceStreamServer below), so it never
// passes through Express's middleware chain — none of the
// express-rate-limit instances in src/api/middleware/security.ts apply
// here. Twilio also doesn't sign the WS upgrade request the way it signs
// HTTP webhooks (verifyTwilioSignature, used by webhooks.ts, has nothing
// to check here), and the first WS message's `customParameters.tenantId`/
// `callerPhone` are taken as given with no further verification — so
// without a limiter of its own, this endpoint is an unauthenticated,
// unlimited-rate entry point into the same Groq-calling pipeline every
// other channel is rate-limited in front of. A simple in-memory sliding
// window, keyed by IP, closes that gap for the connection-flood case; it
// doesn't address spoofed customParameters on an otherwise-legitimate
// connection, which would need signed per-call stream tokens (a bigger
// change than "add rate limiting") to fully close.
const STREAM_CONNECT_WINDOW_MS = 60_000;
const STREAM_CONNECT_LIMIT = 20;
const recentConnectTimestampsByIp = new Map<string, number[]>();

function isStreamConnectRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (recentConnectTimestampsByIp.get(ip) ?? []).filter((t) => now - t < STREAM_CONNECT_WINDOW_MS);
  recent.push(now);
  recentConnectTimestampsByIp.set(ip, recent);
  return recent.length > STREAM_CONNECT_LIMIT;
}

// Opportunistic cleanup so IPs that stop connecting don't sit in the map
// forever — unbounded in a long-running process otherwise.
setInterval(
  () => {
    const now = Date.now();
    for (const [ip, timestamps] of recentConnectTimestampsByIp) {
      const stillRecent = timestamps.filter((t) => now - t < STREAM_CONNECT_WINDOW_MS);
      if (stillRecent.length === 0) {
        recentConnectTimestampsByIp.delete(ip);
      } else {
        recentConnectTimestampsByIp.set(ip, stillRecent);
      }
    }
  },
  5 * 60_000,
).unref();

function clientIpFromUpgradeRequest(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    // First entry is the original client per the standard convention this
    // codebase already relies on elsewhere (Express's own `trust proxy`
    // handling for req.ip).
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  return req.socket.remoteAddress ?? "unknown";
}

// ---------------------------------------------------------------------------
// Twilio Media Streams protocol — minimal typed subset of what we send/receive.
// ---------------------------------------------------------------------------

interface TwilioStartMessage {
  event: "start";
  start: {
    streamSid: string;
    callSid: string;
    customParameters?: { tenantId?: string; callerPhone?: string };
  };
}
interface TwilioMediaMessage {
  event: "media";
  media: { payload: string };
}
interface TwilioStopMessage {
  event: "stop";
}
type TwilioInboundMessage = TwilioStartMessage | TwilioMediaMessage | TwilioStopMessage | { event: "connected" | "mark" };

function isTwilioMessage(value: unknown): value is TwilioInboundMessage {
  return typeof value === "object" && value !== null && typeof (value as { event?: unknown }).event === "string";
}

function sendTwilioMedia(ws: WebSocket, streamSid: string, base64Payload: string): void {
  ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Payload } }));
}

function sendTwilioClear(ws: WebSocket, streamSid: string): void {
  ws.send(JSON.stringify({ event: "clear", streamSid }));
}

// ---------------------------------------------------------------------------
// Per-connection orchestration
// ---------------------------------------------------------------------------

function handleConnection(ws: WebSocket, req: IncomingMessage): void {
  let streamSid: string | null = null;
  let deepgram: DeepgramStreamHandle | null = null;
  let utteranceBuffer = "";
  // Raw mu-law audio for the utterance currently in progress — fed to
  // Whisper (whisperStt.ts) once Deepgram signals the utterance is
  // complete, so the ACTUAL transcription comes from Whisper, not just
  // Deepgram's own real-time (lower-accuracy) text. Deepgram still drives
  // *when* an utterance starts/ends (onSpeechStarted/onUtteranceEnd) —
  // only streaming STT can do that in real time — this buffer exists so
  // there's real audio to hand Whisper once that boundary is known. Reset
  // on onSpeechStarted (a new utterance is starting — discard whatever
  // silence/room-noise accumulated before that point), not just after
  // each turn, so this never grows to cover the whole call.
  let utteranceAudioChunks: Buffer[] = [];
  let turnInFlight = false;
  const clientIp = clientIpFromUpgradeRequest(req);
  // Fetched once, in the "start" handler, and reused for every speak()
  // call on this connection (the greeting, replies, blocked-message
  // fallback) — avoids a redundant getTenantById per turn just to read
  // elevenlabs_voice_id. Null until that resolves, or if the tenant
  // lookup fails; speak()'s voiceId param already falls back to the env
  // var default in that case (fetchElevenLabsSpeechStream), so a
  // still-null cachedTenant is safe, not a blocking condition.
  let cachedTenant: Tenant | null = null;
  // Same idea, for Whisper's dynamic prompt (buildWhisperPrompt, whisperStt.ts)
  // — best-effort, defaults to empty (the prompt still works fine with no
  // service names, just less business-specific bias) rather than blocking
  // anything if the fetch fails.
  let cachedServices: Service[] = [];

  /** `onFirstByte`, if given, fires once — the moment the first audio chunk actually arrives from ElevenLabs — for voice_call_metrics' ttsFirstByteLatencyMs (see onUtteranceEnd below). */
  async function speak(activeStreamSid: string, text: string, onFirstByte?: () => void): Promise<void> {
    const controller = beginAgentSpeech(activeStreamSid);
    if (!controller) return; // Session already ended (e.g. caller hung up mid-processing).
    let firstByteSeen = false;
    if (cachedTenant) {
      void insertUsageEvent({ tenantId: cachedTenant.id, service: "elevenlabs_tts", quantity: text.length, unit: "characters" });
    }
    try {
      await streamTextToSpeech(
        text,
        (chunk) => {
          if (!firstByteSeen) {
            firstByteSeen = true;
            onFirstByte?.();
          }
          if (ws.readyState === ws.OPEN) {
            sendTwilioMedia(ws, activeStreamSid, chunk);
          }
        },
        controller.signal,
        cachedTenant?.elevenlabsVoiceId,
      );
    } catch (error) {
      // Specific, actionable diagnosis for the three failure modes that
      // actually happen in practice (bad/rotated key, quota, missing
      // voice) — the generic "Voice turn failed" catch in handleUtterance
      // still logs this too, but only as an opaque Error object, which
      // isn't enough to tell "wrong key" apart from "ElevenLabs is down"
      // apart from "not configured at all" at a glance in production logs.
      // Also persisted to service_failures (not just console.error) so a
      // super admin can actually SEE this happened without live-tailing
      // server logs — exactly the visibility gap that let the
      // ELEVENLABS_API_KEY drift between environments go unnoticed for a
      // while earlier in this project.
      if (error instanceof ElevenLabsRequestError) {
        const message = `HTTP ${error.status}: ${describeElevenLabsStatus(error.status)} — ${error.message}`;
        console.error(`[ElevenLabs API] Call ${activeStreamSid}: TTS request failed — ${message}`);
        void insertServiceFailure({ tenantId: cachedTenant?.id ?? null, service: "elevenlabs", errorMessage: message });
      } else if (error instanceof ElevenLabsTimeoutError) {
        console.error(`[ElevenLabs API] Call ${activeStreamSid}: TTS request timed out — ${error.message}`);
        void insertServiceFailure({ tenantId: cachedTenant?.id ?? null, service: "elevenlabs", errorMessage: `Timeout: ${error.message}` });
      } else if (error instanceof ElevenLabsNotConfiguredError) {
        console.error(`[ElevenLabs API] Call ${activeStreamSid}: TTS not configured — ${error.message}`);
        void insertServiceFailure({ tenantId: cachedTenant?.id ?? null, service: "elevenlabs", errorMessage: `Not configured: ${error.message}` });
      }
      throw error; // Re-thrown for the existing caller-side catches (greeting / handleUtterance) to handle as before.
    } finally {
      // Must run even on failure — without this, a thrown error above
      // (any of the three cases logged here) left isAgentSpeaking stuck
      // `true` in callSession.ts for the rest of the call: the caller's
      // next utterance would then have interruptAgentSpeech() report "yes,
      // interrupting speech" and send Twilio a spurious "clear" event for
      // audio that was never actually playing, silently masking the real
      // failure state instead of just cleanly closing this turn out.
      endAgentSpeech(activeStreamSid);
    }
  }

  /** Timing for the just-completed turn, or null if nothing billable/measurable happened (blocked by Threat Sentinel, or the turn errored before either the LLM or TTS step) — see onUtteranceEnd's voice_call_metrics insert. */
  interface TurnTiming {
    llmLatencyMs: number;
    ttsFirstByteLatencyMs: number | null;
  }

  async function handleUtterance(tenantId: string, callerPhone: string, transcript: string): Promise<TurnTiming | null> {
    if (!streamSid) return null;
    const activeStreamSid = streamSid;

    // Captured before appending this turn's own caller line below, so
    // it's exactly the turns from earlier in this same call (including
    // the opening greeting) — what processClientMessage needs to make
    // sense of a caller confirming/answering something the agent just
    // asked, instead of treating every utterance as a conversation of one.
    const priorTurns: ConversationTurn[] = (getCallSession(activeStreamSid)?.transcriptTurns ?? []).map((turn) => ({
      role: turn.speaker === "caller" ? "user" : "assistant",
      content: turn.text,
    }));

    appendTranscriptTurn(activeStreamSid, "caller", transcript);

    try {
      // Threat Sentinel gate, ahead of the Groq call — same evaluateThreat()
      // every other channel's entry point uses (see src/security/), just
      // called directly here rather than via the Express middleware
      // wrapper, since this handler isn't an Express request at all.
      const threat = await evaluateThreat({
        message: transcript,
        ipAddress: clientIp,
        tenantId,
        channel: "ai_voice",
      });
      if (threat.blocked) {
        console.warn(`Threat Sentinel blocked a voice utterance from ${clientIp} (category=${threat.category}, score=${threat.score}).`);
        appendTranscriptTurn(activeStreamSid, "agent", GENERIC_BLOCKED_REPLY);
        await speak(activeStreamSid, GENERIC_BLOCKED_REPLY);
        return null;
      }

      const llmStartedAt = Date.now();
      const result = await processClientMessage(tenantId, callerPhone, transcript, "ai_voice", priorTurns);
      const llmLatencyMs = Date.now() - llmStartedAt;

      // Sustained-frustration escalation (callSession.ts) — fires true
      // exactly once, on the turn that crosses the threshold. Appended to
      // this turn's own reply rather than spoken as a separate follow-up
      // utterance, so the caller hears it as one natural continuation,
      // not an abrupt second thing bolted on.
      const justEscalated = recordToneSignal(activeStreamSid, result.toneAssessment);
      const replyToSpeak = justEscalated ? `${result.reply} ${ESCALATION_OFFER_MESSAGE}` : result.reply;

      appendTranscriptTurn(activeStreamSid, "agent", replyToSpeak);
      recordBookingOutcome(activeStreamSid, {
        ...(result.createdAppointmentId ? { createdAppointmentId: result.createdAppointmentId } : {}),
        ...(result.cancelledAppointmentId ? { cancelledAppointmentId: result.cancelledAppointmentId } : {}),
      });

      let ttsFirstByteLatencyMs: number | null = null;
      const ttsStartedAt = Date.now();
      await speak(activeStreamSid, replyToSpeak, () => {
        ttsFirstByteLatencyMs = Date.now() - ttsStartedAt;
      });

      return { llmLatencyMs, ttsFirstByteLatencyMs };
    } catch (error) {
      console.error(`Voice turn failed for call stream ${activeStreamSid}:`, error);
      return null;
    }
  }

  ws.on("message", (raw: RawData) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToUtf8String(raw));
    } catch {
      return;
    }
    if (!isTwilioMessage(parsed)) {
      return;
    }

    if (parsed.event === "start") {
      const { streamSid: sid, callSid, customParameters } = parsed.start;
      const tenantId = customParameters?.tenantId;
      const callerPhone = customParameters?.callerPhone;
      if (!tenantId || !callerPhone) {
        console.error(`Voice stream ${sid} started without tenantId/callerPhone parameters; closing.`);
        ws.close();
        return;
      }

      streamSid = sid;

      // Session creation is awaited (not fire-and-forget) inside this IIFE
      // because the greeting that follows depends on it: appendTranscriptTurn
      // and beginAgentSpeech (inside speak()) both look the session up by
      // streamSid and silently no-op if it isn't there yet — createCallSession
      // awaits a Supabase round-trip (getOrCreateClientProfile) before adding
      // it to the in-memory map, so speaking the greeting before that
      // resolves would mean it never actually plays.
      //
      // getTenantById has no such dependency — it doesn't need the session
      // to exist first — so it runs CONCURRENTLY with createCallSession via
      // Promise.all rather than after it. That's a real, measurable chunk
      // of "silence before the greeting starts" removed: two sequential
      // Supabase round-trips before the ElevenLabs request could even
      // begin, down to whichever of the two is slower. A tenant-lookup
      // failure alone must not abort the call the way a session-creation
      // failure does (that's still fatal — nothing else here works without
      // a session), so it's caught and defaults to null internally rather
      // than rejecting the whole Promise.all.
      void (async () => {
        let tenant: Tenant | null;
        let services: Service[];
        try {
          [, tenant, services] = await Promise.all([
            createCallSession({ callSid, streamSid: sid, tenantId, callerPhone }),
            getTenantById(tenantId).catch((error: unknown) => {
              console.error(`Failed to fetch tenant ${tenantId} for call stream ${sid} (falling back to a generic greeting):`, error);
              return null;
            }),
            // Best-effort, same reasoning as the tenant fetch above —
            // only used for Whisper's dynamic prompt bias, never blocking.
            listServices(tenantId, { activeOnly: true }).catch((error: unknown) => {
              console.error(`Failed to fetch services for tenant ${tenantId} for call stream ${sid} (Whisper prompt will omit them):`, error);
              return [];
            }),
          ]);
        } catch (error) {
          console.error(`Failed to create call session for ${sid}:`, error);
          return;
        }
        cachedTenant = tenant;
        cachedServices = services;
        const greeting = tenant ? getVoiceGreeting(tenant) : DEFAULT_VOICE_GREETING;
        appendTranscriptTurn(sid, "agent", greeting);
        try {
          await speak(sid, greeting);
        } catch (error) {
          console.error(`Failed to speak greeting for call stream ${sid}:`, error);
        }
      })();

      // Deepgram starts listening immediately, in parallel with the
      // greeting above — not after it. That way if the caller starts
      // talking while the greeting is still playing, the existing
      // onSpeechStarted barge-in handling below (interruptAgentSpeech +
      // sendTwilioClear) cuts it off exactly like it would for any other
      // agent turn, rather than the caller having to wait it out.
      deepgram = openDeepgramStream({
        onTranscript: (text, isFinal) => {
          if (isFinal) {
            utteranceBuffer = utteranceBuffer.length > 0 ? `${utteranceBuffer} ${text}` : text;
          }
        },
        onUtteranceEnd: () => {
          if (turnInFlight || (utteranceBuffer.trim().length === 0 && utteranceAudioChunks.length === 0)) {
            return;
          }
          const turnStartedAt = Date.now();
          const deepgramTranscript = utteranceBuffer.trim();
          const audioSnapshot = utteranceAudioChunks.length > 0 ? Buffer.concat(utteranceAudioChunks) : null;
          utteranceBuffer = "";
          utteranceAudioChunks = [];
          turnInFlight = true;
          void (async () => {
            // Whisper only runs when this tenant opted into the hybrid
            // strategy (tenants.stt_strategy, free for every plan — see
            // tenantSettings.ts) — it's a real extra network round-trip on
            // top of Deepgram's own real-time transcript, which is exactly
            // the "the agent takes too long to respond" tradeoff a tenant
            // should choose deliberately, not have forced on them.
            // Deepgram's own text is the fallback either way: when Whisper
            // is off, when it can't produce a transcript (not configured,
            // request failed/timed out, the buffered audio really was
            // silence per its RMS gate), or when there's no tenant yet to
            // build a prompt for. Never both silently dropped: if Whisper
            // comes back empty, Deepgram's transcript (if any) still
            // carries the turn.
            let transcript = deepgramTranscript;
            let whisperUsed = false;
            let whisperLatencyMs: number | null = null;
            if (cachedTenant?.sttStrategy === "whisper_hybrid" && audioSnapshot) {
              whisperUsed = true;
              // mu-law is exactly 1 byte/sample at Whisper's 8kHz — real
              // audio duration, not an estimate.
              void insertUsageEvent({ tenantId: cachedTenant.id, service: "groq_whisper", quantity: audioSnapshot.length / 8000, unit: "seconds" });
              const whisperStartedAt = Date.now();
              const whisperTranscript = await transcribeWithWhisper(audioSnapshot, cachedTenant, cachedServices);
              whisperLatencyMs = Date.now() - whisperStartedAt;
              if (whisperTranscript) {
                transcript = whisperTranscript;
              }
            }
            if (!transcript) {
              return; // Both Whisper (if used) and Deepgram came up empty — nothing to act on this turn.
            }

            const timing = await handleUtterance(tenantId, callerPhone, transcript);

            // Best-effort, fire-and-forget — see insertVoiceCallMetric's
            // own header comment. Skipped entirely if the tenant lookup
            // never resolved (tenant_id is required on this table); that's
            // an edge case rare enough not to need a "log with no tenant"
            // path the way service_failures has one.
            if (cachedTenant) {
              void insertVoiceCallMetric({
                tenantId: cachedTenant.id,
                streamSid: sid,
                sttStrategy: cachedTenant.sttStrategy,
                whisperUsed,
                whisperLatencyMs,
                llmLatencyMs: timing?.llmLatencyMs ?? null,
                ttsFirstByteLatencyMs: timing?.ttsFirstByteLatencyMs ?? null,
                totalTurnLatencyMs: Date.now() - turnStartedAt,
              }).catch((error: unknown) => {
                console.error(`Failed to record voice call metric for call ${sid}:`, error);
              });
            }
          })().finally(() => {
            turnInFlight = false;
          });
        },
        onSpeechStarted: () => {
          // A new utterance is starting — discard whatever silence/room
          // noise accumulated in the buffer since the last one ended, so
          // it never grows to cover dead air between turns.
          utteranceAudioChunks = [];
          if (!streamSid) return;
          const wasSpeaking = interruptAgentSpeech(streamSid);
          if (wasSpeaking) {
            sendTwilioClear(ws, streamSid);
          }
        },
        onError: (error) => {
          console.error(`Deepgram stream error for call ${sid}:`, error);
        },
        onClose: () => {
          /* Nothing to do — the Twilio "stop" event (or ws close) drives session cleanup. */
        },
      });
      return;
    }

    if (parsed.event === "media" && "media" in parsed) {
      const audioChunk = Buffer.from(parsed.media.payload, "base64");
      deepgram?.sendAudio(audioChunk);
      // Same raw mu-law bytes, also buffered for Whisper (see
      // onUtteranceEnd/onSpeechStarted above) — decoded once here, not
      // twice, since both consumers want the identical bytes.
      utteranceAudioChunks.push(audioChunk);
      return;
    }

    if (parsed.event === "stop") {
      deepgram?.close();
      deepgram = null;
      if (streamSid) {
        void endCallSession(streamSid);
      }
      return;
    }
  });

  ws.on("close", () => {
    deepgram?.close();
    deepgram = null;
    if (streamSid) {
      void endCallSession(streamSid);
    }
  });

  ws.on("error", (error: Error) => {
    console.error("Voice WebSocket connection error:", error);
  });
}

/**
 * Attaches the voice stream WebSocket server to an existing HTTP server via
 * the `upgrade` event, so Twilio's `wss://` connection shares the same
 * port/process as the Express app rather than needing a second listener.
 */
export function attachVoiceStreamServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith(VOICE_STREAM_PATH)) {
      return; // Not ours — leave it for any other upgrade handler (or the default rejection).
    }

    const ip = clientIpFromUpgradeRequest(req);
    if (isStreamConnectRateLimited(ip)) {
      console.warn(`Voice stream connection rate limit exceeded for ${ip}; rejecting upgrade.`);
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", handleConnection);

  return wss;
}
