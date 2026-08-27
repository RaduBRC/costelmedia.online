/**
 * Deepgram real-time streaming STT, over their own WebSocket API — chosen
 * over Groq's Whisper endpoint specifically because Whisper there is a
 * batch (send-a-complete-file, get-one-transcript) REST call, not a
 * streaming protocol: it can't produce interim results or endpointing
 * (turn-end) signals as audio arrives, both of which the < 800ms latency
 * target and natural turn-taking depend on. Deepgram's free tier includes
 * real-time streaming.
 */
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { rawDataToUtf8String } from "./rawData.js";

const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";

export interface DeepgramStreamCallbacks {
  /** Fires for both interim and final results; `isFinal`/`speechFinal` distinguish them. */
  onTranscript: (transcript: string, isFinal: boolean, speechFinal: boolean) => void;
  /** Deepgram's endpointing signal that the caller has finished a turn. */
  onUtteranceEnd: () => void;
  /** Fires when the caller starts talking — the barge-in trigger while the agent is mid-response. */
  onSpeechStarted: () => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

export interface DeepgramStreamHandle {
  sendAudio: (chunk: Buffer) => void;
  close: () => void;
}

interface DeepgramResultsMessage {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

function isDeepgramMessage(value: unknown): value is { type: string } {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function isResultsMessage(value: { type: string }): value is DeepgramResultsMessage {
  return value.type === "Results";
}

/**
 * Opens one Deepgram connection for a single call leg. `mulaw`/8000Hz/mono
 * matches Twilio Media Streams' native format exactly, so no client-side
 * audio transcoding is needed — inbound Twilio "media" payloads are
 * forwarded to `sendAudio` as-is.
 */
// How long the caller has to go silent before Deepgram considers their
// turn over. Lowered from the original 300/1000 after live feedback that
// the agent waited noticeably too long to respond — 1000ms of required
// silence reads as a real, human-perceptible pause on a phone call, on
// top of Deepgram's own endpointing delay. Not dropped further than this:
// below roughly 500ms, a caller's normal mid-sentence pause ("da, deci...
// <breath> ...aș vrea") risks being read as the end of their turn,
// which would be a worse regression (the agent talking over them) than
// the slower-response complaint this fixes. Both overridable via env var
// without a code change if real call data says otherwise.
const ENDPOINTING_MS = Number(process.env["DEEPGRAM_ENDPOINTING_MS"] ?? 250);
const UTTERANCE_END_MS = Number(process.env["DEEPGRAM_UTTERANCE_END_MS"] ?? 600);

export function openDeepgramStream(callbacks: DeepgramStreamCallbacks): DeepgramStreamHandle {
  const apiKey = process.env["DEEPGRAM_API_KEY"];
  if (!apiKey) {
    throw new Error("Missing DEEPGRAM_API_KEY environment variable.");
  }
  const model = process.env["DEEPGRAM_MODEL"] ?? "nova-2";

  const url =
    `${DEEPGRAM_LISTEN_URL}?encoding=mulaw&sample_rate=8000&channels=1` +
    `&interim_results=true&endpointing=${ENDPOINTING_MS}&utterance_end_ms=${UTTERANCE_END_MS}&vad_events=true&punctuate=true` +
    `&model=${encodeURIComponent(model)}`;

  const socket = new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } });
  let isOpen = false;
  let pendingChunks: Buffer[] = [];

  socket.on("open", () => {
    isOpen = true;
    for (const chunk of pendingChunks) {
      socket.send(chunk);
    }
    pendingChunks = [];
  });

  socket.on("message", (data: RawData) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToUtf8String(data));
    } catch {
      return;
    }
    if (!isDeepgramMessage(parsed)) {
      return;
    }

    if (isResultsMessage(parsed)) {
      const transcript = parsed.channel?.alternatives?.[0]?.transcript;
      if (transcript && transcript.length > 0) {
        callbacks.onTranscript(transcript, parsed.is_final ?? false, parsed.speech_final ?? false);
      }
    } else if (parsed.type === "UtteranceEnd") {
      callbacks.onUtteranceEnd();
    } else if (parsed.type === "SpeechStarted") {
      callbacks.onSpeechStarted();
    }
  });

  socket.on("error", (error: Error) => {
    callbacks.onError(error);
  });

  socket.on("close", () => {
    isOpen = false;
    pendingChunks = []; // release any audio queued before the socket ever opened
    callbacks.onClose();
  });

  return {
    sendAudio(chunk: Buffer) {
      if (isOpen && socket.readyState === WebSocket.OPEN) {
        socket.send(chunk);
      } else {
        pendingChunks.push(chunk);
      }
    },
    close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try {
          socket.close();
        } catch {
          // Already closing/closed — nothing to do.
        }
      }
    },
  };
}
