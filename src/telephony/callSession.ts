/**
 * Active voice-call state, keyed by Twilio's `streamSid`. Each entry is
 * only ever touched by one WebSocket connection's message handlers (see
 * voiceStreamServer.ts) — Node's single-threaded event loop means there's
 * no concurrent access to *within* one call's state, and different calls
 * never share a session object, so there's nothing to lock between them
 * either. The one thing that does need explicit handling is cleanup:
 * `endCallSession` is idempotent (removes from the map before doing
 * anything else) so it's safe to call from both the Twilio "stop" event
 * and the WebSocket "close" event without double-processing.
 *
 * client_profiles already gets updated per-turn by processClientMessage's
 * own tone-assessment pass (same as the chat/SMS channels) — nothing
 * extra to do here for that. What *is* voice-specific is the full-call
 * transcript, written to `call_transcripts` at endCallSession.
 */
import { getOrCreateClientProfile, insertCallTranscript } from "../db/supabase.js";

interface TranscriptTurn {
  speaker: "caller" | "agent";
  text: string;
  at: string;
}

export interface CallSession {
  callSid: string;
  streamSid: string;
  tenantId: string;
  callerPhone: string;
  clientId: string;
  transcriptTurns: TranscriptTurn[];
  startedAtMs: number;
  isAgentSpeaking: boolean;
  ttsAbortController: AbortController | null;
  createdAppointmentId: string | null;
  cancelledAppointmentId: string | null;
}

const sessions = new Map<string, CallSession>();

export async function createCallSession(params: {
  callSid: string;
  streamSid: string;
  tenantId: string;
  callerPhone: string;
}): Promise<CallSession> {
  const clientProfile = await getOrCreateClientProfile(params.tenantId, params.callerPhone);

  const session: CallSession = {
    ...params,
    clientId: clientProfile.id,
    transcriptTurns: [],
    startedAtMs: Date.now(),
    isAgentSpeaking: false,
    ttsAbortController: null,
    createdAppointmentId: null,
    cancelledAppointmentId: null,
  };
  sessions.set(params.streamSid, session);
  return session;
}

export function getCallSession(streamSid: string): CallSession | undefined {
  return sessions.get(streamSid);
}

export function appendTranscriptTurn(streamSid: string, speaker: "caller" | "agent", text: string): void {
  const session = sessions.get(streamSid);
  if (!session || text.trim().length === 0) {
    return;
  }
  session.transcriptTurns.push({ speaker, text, at: new Date().toISOString() });
}

export function recordBookingOutcome(streamSid: string, outcome: { createdAppointmentId?: string; cancelledAppointmentId?: string }): void {
  const session = sessions.get(streamSid);
  if (!session) {
    return;
  }
  if (outcome.createdAppointmentId) {
    session.createdAppointmentId = outcome.createdAppointmentId;
  }
  if (outcome.cancelledAppointmentId) {
    session.cancelledAppointmentId = outcome.cancelledAppointmentId;
  }
}

/** Marks the agent as speaking and returns the AbortController to cut its TTS stream short on barge-in. */
export function beginAgentSpeech(streamSid: string): AbortController | undefined {
  const session = sessions.get(streamSid);
  if (!session) {
    return undefined;
  }
  const controller = new AbortController();
  session.isAgentSpeaking = true;
  session.ttsAbortController = controller;
  return controller;
}

export function endAgentSpeech(streamSid: string): void {
  const session = sessions.get(streamSid);
  if (!session) {
    return;
  }
  session.isAgentSpeaking = false;
  session.ttsAbortController = null;
}

/**
 * Barge-in: if the agent is currently speaking, aborts its TTS stream and
 * returns true — the caller (voiceStreamServer.ts) uses that to know it
 * should also send Twilio a "clear" event to flush already-buffered audio.
 * Returns false if the agent wasn't speaking (nothing to interrupt).
 */
export function interruptAgentSpeech(streamSid: string): boolean {
  const session = sessions.get(streamSid);
  if (!session || !session.isAgentSpeaking) {
    return false;
  }
  session.ttsAbortController?.abort();
  session.isAgentSpeaking = false;
  session.ttsAbortController = null;
  return true;
}

/** Idempotent: writes the accumulated transcript (if any) and removes the session. Safe to call more than once for the same call. */
export async function endCallSession(streamSid: string): Promise<void> {
  const session = sessions.get(streamSid);
  if (!session) {
    return;
  }
  sessions.delete(streamSid);

  if (session.transcriptTurns.length === 0) {
    return; // Call ended before any speech was transcribed — nothing to record.
  }

  const transcript = session.transcriptTurns.map((turn) => `${turn.speaker === "caller" ? "Caller" : "Agent"}: ${turn.text}`).join("\n");
  const durationSeconds = Math.round((Date.now() - session.startedAtMs) / 1000);

  try {
    await insertCallTranscript({
      tenantId: session.tenantId,
      clientId: session.clientId,
      appointmentId: session.createdAppointmentId,
      callSid: session.callSid,
      transcript,
      durationSeconds,
    });
  } catch (error) {
    console.error(`Failed to save call transcript for call ${session.callSid}:`, error);
  }
}
