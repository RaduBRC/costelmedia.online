/**
 * In-browser voice call simulator — tests the same booking pipeline a
 * real Twilio call reaches, without needing Twilio. The browser's own
 * Web Speech API stands in for Twilio's audio stream/Deepgram on the
 * input side: SpeechRecognition transcribes the mic locally, and the
 * transcript goes to the exact same POST /api/tenants/:tenantId/chat
 * route ChatSimulator.tsx uses (just with `channel: "ai_voice"` — see
 * src/lib/api.ts's sendChatMessage). Any appointment booked this way is
 * tagged `booking_channel: 'ai_voice'` in Supabase, same as a real phone
 * call — that tagging comes from the `channel` argument threaded through
 * processClientMessage (src/agent/groqAgent.ts), which this component
 * doesn't bypass in any way.
 *
 * Output side: replies are spoken via the *real* ElevenLabs voice
 * (POST /api/tts, src/api/routes/tts.ts — the same model/voice_settings
 * the actual Twilio pipeline uses, see src/telephony/elevenLabsTts.ts),
 * falling back to the browser's own SpeechSynthesis on any failure.
 *
 * ---------------------------------------------------------------------
 * Call-initiation sequence (rewritten after repeated reports of the
 * "Începe Apel Vocal" button hanging with no visible feedback):
 *
 *   1. connecting  — AudioContext resumed, getUserMedia requested.
 *      Mic denial is now a hard stop (status "error", clear Romanian
 *      message) rather than a silent fallback — a permission failure is
 *      actionable ("go allow the mic and retry"), unlike a genuine
 *      capability gap (see below), so it deserves to stop and say so.
 *   2. speaking     — the scripted greeting plays: ElevenLabs first, with
 *      an explicit, logged fallback to SpeechSynthesis on ANY failure
 *      (not configured, timeout, quota, playback blocked — all treated
 *      the same: fall back and keep going).
 *   3. listening    — opened only once the greeting has *fully* finished
 *      (`onended`/`onend`), never before, never in parallel. Stays
 *      "listening" for as long as the caller keeps talking, including
 *      mid-sentence pauses — the turn only ends after SILENCE_TIMEOUT_MS
 *      of genuine silence (see startMicrophoneListening), not the
 *      browser's own much shorter built-in cutoff.
 *
 * Every step below calls logDebug(), which both console.logs and appends
 * to a visible on-screen panel — the root cause of the "it just hangs"
 * reports turned out to be that failures were happening but were
 * completely invisible (see elevenLabsTts.ts's header comment: no
 * timeout anywhere meant a hung upstream request produced a promise that
 * never settled at all, not one that errored quickly). The debug panel
 * and the request timeouts are the fix for both the silence and the hang.
 * ---------------------------------------------------------------------
 *
 * Two layouts share one state machine: a compact "call card" below the
 * `md` breakpoint (phone-app-style, big circular button, waveform while
 * the agent speaks) and a transcript-log view at `md` and above. Neither
 * is a separate component — same hooks, same handlers, just two JSX
 * blocks toggled with `md:hidden`/`hidden md:block` so there's exactly
 * one place the call logic can drift out of sync with itself.
 *
 * Mobile realities this still accounts for:
 *  - iOS Safari has never implemented SpeechRecognition (Chrome/Edge
 *    only, including on Android — Apple simply hasn't shipped it on any
 *    platform). That's a *capability* gap, not a permission failure, so
 *    it still degrades gracefully to a typed-text fallback rather than
 *    hard-stopping the call — SpeechSynthesis output still works there.
 *  - `speechSynthesis.speak()`/`HTMLMediaElement.play()`/`AudioContext`
 *    calls that aren't triggered by (or don't trace back to) a user
 *    gesture can be silently ignored on iOS Safari. unlockSpeechSynthesis,
 *    unlockAudioPlayback, and the AudioContext resume in startCall all run
 *    synchronously inside the button's own onClick, before any `await`,
 *    to unlock all three for the rest of the session.
 *  - iOS Safari has a long-standing bug where an utterance can be cut
 *    short if its SpeechSynthesisUtterance object gets garbage-collected
 *    mid-speech (speak() doesn't hold a strong reference) — utteranceRef
 *    keeps one alive for the duration. audioRef does the equivalent job
 *    for the ElevenLabs <audio> element, and doubles as how endCall stops
 *    playback immediately if the call ends mid-reply.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, Keyboard, Mic, MicOff, Phone, PhoneOff, Send, User, Volume2 } from "lucide-react";
import { sendChatMessage, synthesizeSpeech, TtsError } from "../lib/api.js";
import { useToast } from "./Toast.js";

const SPEECH_LANG = "ro-RO";
// Total silence after the last detected speech (interim or final) before a
// turn is considered finished and sent to the backend. Configurable here,
// not baked into the browser's own (short, non-configurable) end-of-speech
// heuristic — see startMicrophoneListening's continuous=true comment for
// why that heuristic can't be used directly.
const SILENCE_TIMEOUT_MS = 2000;
// Scripted, not Groq-generated, same reasoning as the real voice
// pipeline's greeting (see src/agent/promptBuilder.ts's getVoiceGreeting):
// guaranteed exact wording, spoken immediately with no LLM round-trip.
const VOICE_GREETING = "Bună ziua! Bine ați venit la clinica noastră. Cu ce vă pot ajuta astăzi?";
const MAX_DEBUG_LOG_LINES = 60;

type CallStatus = "idle" | "connecting" | "listening" | "processing" | "speaking" | "error";

interface TurnEntry {
  id: string;
  role: "caller" | "agent";
  text: string;
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/**
 * Builds a real, valid, silent WAV file (44-byte header, zero data bytes)
 * as a blob URL — used only to "unlock" HTMLMediaElement playback on iOS
 * Safari (see unlockAudioPlayback below). Built at runtime from a
 * hand-written header rather than a hardcoded base64 string so its
 * correctness doesn't depend on correctly remembering/copying one.
 */
function createSilentAudioUrl(): string {
  const sampleRate = 8000;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36, true); // file length - 8, with 0 data bytes
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate (mono, 8-bit)
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, 0, true); // zero data bytes — genuinely silent, not just quiet
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

function pickRomanianVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  return voices.find((voice) => voice.lang.toLowerCase() === "ro-ro") ?? voices.find((voice) => voice.lang.toLowerCase().startsWith("ro")) ?? null;
}

function describeError(error: unknown): string {
  if (error instanceof TtsError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Stylized "the agent is talking" indicator — not real amplitude (SpeechSynthesis/the ElevenLabs MP3 blob expose no audio stream to analyze). */
function SpeakingWaveform({ active }: { active: boolean }): JSX.Element {
  return (
    <div className="flex h-7 items-end justify-center gap-1" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`w-1.5 rounded-full bg-white transition-all ${active ? "h-7 animate-[waveform-bar_0.9s_ease-in-out_infinite]" : "h-1.5 opacity-60"}`}
          style={active ? { animationDelay: `${i * 0.1}s` } : undefined}
        />
      ))}
    </div>
  );
}

export default function VoiceCallSimulator({ tenantId }: { tenantId: string }): JSX.Element {
  const { showToast } = useToast();
  const [clientPhone, setClientPhone] = useState("+40712345678");
  const [callActive, setCallActive] = useState(false);
  const [status, setStatus] = useState<CallStatus>("idle");
  const [interimText, setInterimText] = useState("");
  const [turns, setTurns] = useState<TurnEntry[]>([]);
  const [ttsSupported, setTtsSupported] = useState(true);
  const [sttSupported, setSttSupported] = useState(true);
  const [micDenied, setMicDenied] = useState(false);
  const [textFallbackDraft, setTextFallbackDraft] = useState("");
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // Our own end-of-turn detection, since continuous=true means the
  // recognizer itself never decides "the caller is done talking" — see
  // startMicrophoneListening. silenceTimerRef holds the pending
  // SILENCE_TIMEOUT_MS countdown (reset on every onresult); accumulatedTranscriptRef
  // collects `isFinal` chunks across the whole listening session, since
  // continuous mode can emit several of them before the caller is
  // actually finished with their turn.
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accumulatedTranscriptRef = useRef("");
  const callActiveRef = useRef(false);
  const sttSupportedRef = useRef(true);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const debugAnchorRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  // Keeps the current utterance alive for its whole duration — iOS Safari
  // has been known to cut speech short if this object is garbage
  // collected mid-utterance (speak() itself only holds a weak reference).
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  // The currently-playing ElevenLabs <audio> element, if any — lets
  // endCall() stop playback immediately instead of letting a reply finish
  // speaking after the caller has already hung up.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const micAvailableRef = useRef(false);
  // Set on the first ElevenLabs failure of a given call so the toast below
  // fires once per call, not once per reply — every turn still falls back
  // to browser TTS and logs full detail to the debug panel regardless, this
  // only throttles the toast so a whole conversation with ElevenLabs down
  // doesn't spam the same "switched to fallback voice" message every turn.
  const elevenLabsFailureToastShownRef = useRef(false);
  // Mirrors `status` for reads inside recognition.onend's closure, which
  // is only re-created when `showToast` changes (practically: once) —
  // reading the `status` state variable directly there would always see
  // whatever it was on that first render, not the current value. Updated
  // synchronously alongside every setStatus call via setCallStatus below,
  // so onend never sees a lagging value even within the same tick.
  const statusRef = useRef<CallStatus>("idle");
  const setCallStatus = useCallback((next: CallStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const logDebug = useCallback((message: string) => {
    const line = `[${new Date().toLocaleTimeString("ro-RO", { hour12: false })}] ${message}`;
    console.log("[VOICE DEBUG]", message);
    setDebugLog((current) => [...current, line].slice(-MAX_DEBUG_LOG_LINES));
  }, []);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  useEffect(() => {
    debugAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [debugLog]);

  useEffect(() => {
    const hasTts = typeof window !== "undefined" && !!window.speechSynthesis;
    setTtsSupported(hasTts);
    const hasStt = !!getSpeechRecognitionConstructor();
    setSttSupported(hasStt);
    sttSupportedRef.current = hasStt;
    if (hasTts) {
      // Voice lists load asynchronously in some browsers — this just
      // warms the cache so pickRomanianVoice() has something to search
      // the first time it's called, not a functional dependency of
      // anything else here.
      window.speechSynthesis.getVoices();
    }
  }, []);

  /**
   * Speaks a near-silent utterance synchronously inside a user-gesture
   * handler (startCall's onClick, before any `await`) to unlock
   * SpeechSynthesis playback for the rest of the call on iOS Safari,
   * which otherwise silently drops speak() calls not directly traceable
   * to a gesture — which every *later* turn's reply would be, since it
   * follows an awaited network round-trip.
   */
  const unlockSpeechSynthesis = useCallback(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const unlock = new SpeechSynthesisUtterance(" ");
    unlock.volume = 0;
    window.speechSynthesis.speak(unlock);
  }, []);

  /**
   * Same idea as unlockSpeechSynthesis above, but for the ElevenLabs
   * <audio> element playback path — HTMLMediaElement.play() has the same
   * gesture-tracing requirement on iOS Safari. The blob URL is only
   * revoked once play() has settled (resolved or rejected), not
   * synchronously after calling it — revoking it earlier can make the
   * play() call itself fail on some browsers ("no supported source was
   * found"), which is exactly backwards for a function whose whole job
   * is making sure playback works.
   */
  const unlockAudioPlayback = useCallback(() => {
    if (typeof window === "undefined" || typeof Audio === "undefined") return;
    try {
      const url = createSilentAudioUrl();
      const unlock = new Audio(url);
      unlock.volume = 0;
      unlock
        .play()
        .catch(() => {
          /* Best-effort — if this is blocked too, real playback later just falls back to browser TTS instead of erroring. */
        })
        .finally(() => {
          URL.revokeObjectURL(url);
        });
    } catch {
      /* Same — best-effort unlock, never fatal to starting the call. */
    }
  }, []);

  const speakWithBrowserTts = useCallback(
    (text: string): Promise<void> => {
      return new Promise((resolve) => {
        if (typeof window === "undefined" || !window.speechSynthesis) {
          logDebug("SpeechSynthesis fallback unavailable in this browser — reply will not be read aloud.");
          resolve();
          return;
        }
        logDebug("Se folosește SpeechSynthesis din browser (fallback)...");
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = SPEECH_LANG;
        // Slightly below the 1.0 default rate and a touch below neutral
        // pitch reads as calmer/more measured without sounding slowed-down
        // or artificial. Only matters for this fallback path — the
        // primary ElevenLabs path's tone is tuned server-side (see
        // elevenLabsTts.ts's VOICE_SETTINGS).
        utterance.rate = 0.92;
        utterance.pitch = 0.95;
        const voice = pickRomanianVoice();
        if (voice) {
          utterance.voice = voice;
        }
        utterance.onend = () => {
          logDebug("Browser SpeechSynthesis playback finished.");
          utteranceRef.current = null;
          resolve();
        };
        utterance.onerror = (event) => {
          logDebug(`Browser SpeechSynthesis error: ${event.error}`);
          utteranceRef.current = null;
          resolve();
        };
        utteranceRef.current = utterance; // see the ref's own comment above
        window.speechSynthesis.cancel(); // clear anything queued/interrupted from a prior turn
        window.speechSynthesis.speak(utterance);
      });
    },
    [logDebug],
  );

  /**
   * Plays `text` via the real ElevenLabs voice (POST /api/tts), falling
   * back to speakWithBrowserTts above on ANY failure — not configured,
   * timeout, quota/plan restriction, network error, or playback itself
   * failing (e.g. an iOS Safari gesture-policy block despite
   * unlockAudioPlayback). Every failure is logged with its exact code and
   * message before falling back, so "it didn't work" is always traceable
   * to a specific, visible reason.
   */
  const speak = useCallback(
    (text: string): Promise<void> => {
      logDebug("Se apelează ElevenLabs API...");
      return synthesizeSpeech(text)
        .then(
          (blob) =>
            new Promise<void>((resolve, reject) => {
              const url = URL.createObjectURL(blob);
              const audio = new Audio(url);
              audioRef.current = audio;
              const cleanup = (): void => {
                URL.revokeObjectURL(url);
                if (audioRef.current === audio) {
                  audioRef.current = null;
                }
              };
              audio.onended = () => {
                logDebug("ElevenLabs playback finished.");
                cleanup();
                resolve();
              };
              audio.onerror = () => {
                cleanup();
                reject(new Error("ElevenLabs audio playback failed."));
              };
              audio.play().catch((error: unknown) => {
                cleanup();
                reject(error instanceof Error ? error : new Error("ElevenLabs audio playback was blocked."));
              });
            }),
        )
        .catch((error: unknown) => {
          logDebug(`ElevenLabs failed (${describeError(error)}). Falling back to Browser Web Speech API...`);
          // Visible, not just in the debug panel — a failure here means
          // every reply for the rest of this call sounds different (robotic
          // browser TTS instead of the real ElevenLabs voice) and staff
          // testing the call should know why without having to scroll the
          // debug log to notice. Once per call, not once per reply.
          if (!elevenLabsFailureToastShownRef.current) {
            elevenLabsFailureToastShownRef.current = true;
            showToast("ElevenLabs voice unavailable — falling back to your browser's built-in voice for this call.", "error");
          }
          return speakWithBrowserTts(text);
        });
    },
    [speakWithBrowserTts, logDebug, showToast],
  );

  const stopListening = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    recognitionRef.current?.stop();
  }, []);

  /** Opened only after the greeting has fully finished playing — see the file header for why this ordering matters. */
  const startMicrophoneListening = useCallback(() => {
    if (!callActiveRef.current || !sttSupportedRef.current) return;
    const RecognitionCtor = getSpeechRecognitionConstructor();
    if (!RecognitionCtor) return;

    logDebug("Pornim ascultarea microfonului...");
    accumulatedTranscriptRef.current = "";
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    const recognition = new RecognitionCtor();
    recognition.lang = SPEECH_LANG;
    // continuous=true: the recognizer keeps listening across the
    // browser's own internal utterance boundaries instead of auto-
    // stopping the instant it detects the first (short, ~1s, not
    // configurable via any Web Speech API option) pause — that short
    // heuristic is exactly what was cutting callers off mid-sentence.
    // With continuous=true, WE decide when a turn is over, via the
    // silence timer below — the recognizer itself never stops on its own.
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    /** Ends the current turn: takes whatever's been said so far and sends it, then stops the recognizer. Called either by the silence timer expiring, or (defensively) from onend if the browser stopped the recognizer before we did. */
    const finalizeTurn = (calledFromOnEnd: boolean): void => {
      if (silenceTimerRef.current !== null) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      const transcript = accumulatedTranscriptRef.current.trim();
      accumulatedTranscriptRef.current = "";
      setInterimText("");
      if (!transcript) {
        return;
      }
      // handleFinalTranscript sets status to "processing" synchronously
      // before its first await — calling it before recognition.stop()
      // matters when we're the ones initiating the stop (not already
      // inside onend): it guarantees onend's own restart-guard below sees
      // the updated status instead of racing it.
      void handleFinalTranscript(transcript);
      if (!calledFromOnEnd) {
        recognition.stop();
      }
    };

    const resetSilenceTimer = (): void => {
      if (silenceTimerRef.current !== null) {
        clearTimeout(silenceTimerRef.current);
      }
      silenceTimerRef.current = setTimeout(() => finalizeTurn(false), SILENCE_TIMEOUT_MS);
    };

    recognition.onstart = () => {
      setCallStatus("listening");
      setInterimText("");
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results.item(i);
        const alternative = result.item(0);
        if (result.isFinal) {
          accumulatedTranscriptRef.current += alternative.transcript;
        } else {
          interim += alternative.transcript;
        }
      }
      setInterimText(interim);
      // Every result — interim or final — is evidence the caller is still
      // talking, so the silence clock restarts either way: a mid-sentence
      // pause for a word never gets close to SILENCE_TIMEOUT_MS as long as
      // speech keeps producing *any* recognition events. Status stays
      // "listening" throughout (set once in onstart) — nothing here
      // changes it, satisfying "stay visually listening until the silence
      // timer actually expires."
      resetSilenceTimer();
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "no-speech" || event.error === "aborted") {
        // Not a real problem — the caller just paused or the call ended
        // mid-listen; onend below decides whether to restart.
        return;
      }
      if (event.error === "not-allowed") {
        logDebug("Microphone permission was revoked mid-call.");
        setMicDenied(true);
        setCallActive(false);
        callActiveRef.current = false;
        setCallStatus("error");
        return;
      }
      logDebug(`Speech recognition error: ${event.error} — ${event.message}`);
      showToast(`Speech recognition error: ${event.error}`, "error");
    };

    recognition.onend = () => {
      // Reached either via finalizeTurn's own recognition.stop() call
      // above (expected — the silence timer already decided the turn was
      // over), or unexpectedly: the browser gave up on its own, an error
      // fired, or the call ended mid-listen. If a silence timer is still
      // pending here, we're in that second case — finalize whatever was
      // actually said rather than silently discarding it, instead of
      // just restarting with the mic having "forgotten" the caller's
      // words. (finalizeTurn no-ops harmlessly if nothing was said yet.)
      if (silenceTimerRef.current !== null) {
        finalizeTurn(true);
        return;
      }
      // Reads statusRef, not the `status` state variable directly — see
      // its declaration above for why.
      if (callActiveRef.current && statusRef.current !== "processing" && statusRef.current !== "speaking") {
        startMicrophoneListening();
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleFinalTranscript is referenced but intentionally omitted: it's only invoked from async event callbacks that fire well after render (never synchronously during this closure's creation), by which point it's fully initialized — adding it here would force recreating the whole recognizer (and losing an in-progress mic session) on every unrelated state change that happens to redefine handleFinalTranscript.
  }, [showToast, logDebug]);

  const handleFinalTranscript = useCallback(
    async (transcript: string) => {
      if (!tenantId.trim()) {
        showToast("Enter a tenant id in the header before starting a voice call.", "error");
        return;
      }
      setTurns((current) => [...current, { id: crypto.randomUUID(), role: "caller", text: transcript }]);
      setCallStatus("processing");
      logDebug(`Caller: "${transcript}"`);

      try {
        const result = await sendChatMessage(tenantId.trim(), clientPhone.trim(), transcript, "ai_voice");
        setTurns((current) => [...current, { id: crypto.randomUUID(), role: "agent", text: result.reply }]);
        setCallStatus("speaking");
        await speak(result.reply);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to reach the booking pipeline.";
        logDebug(`Booking pipeline error: ${message}`);
        showToast(message, "error");
        setTurns((current) => [...current, { id: crypto.randomUUID(), role: "agent", text: `⚠ ${message}` }]);
      } finally {
        if (callActiveRef.current && sttSupportedRef.current) {
          startMicrophoneListening();
        } else {
          setCallStatus("idle");
        }
      }
    },
    [tenantId, clientPhone, showToast, speak, startMicrophoneListening, setCallStatus, logDebug],
  );

  const endCall = useCallback(() => {
    logDebug("Apel încheiat.");
    callActiveRef.current = false;
    setCallActive(false);
    setCallStatus("idle");
    setInterimText("");
    setTextFallbackDraft("");
    stopListening();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, [stopListening, setCallStatus, logDebug]);

  /**
   * Plays the greeting, then — once it has *fully* finished, never before
   * — opens the mic if one's available. This ordering is the fix for the
   * feedback-loop/self-cancellation bug: starting SpeechRecognition while
   * the greeting is still coming out of the speakers risked it hearing
   * the greeting itself and treating it as something the caller said.
   * Sequential is also a deliberate difference from the real Twilio
   * pipeline's barge-in (voiceStreamServer.ts), where Deepgram listens on
   * the caller's own phone line, fully isolated from Twilio's TTS output
   * — there's no such isolation between this device's speakers and its
   * own microphone.
   */
  const speakGreetingThenListen = useCallback(() => {
    setTurns([{ id: crypto.randomUUID(), role: "agent", text: VOICE_GREETING }]);
    setCallStatus("speaking");
    void speak(VOICE_GREETING).then(() => {
      if (!callActiveRef.current) return; // call was ended while the greeting was still playing
      if (sttSupportedRef.current && micAvailableRef.current) {
        startMicrophoneListening();
      } else {
        // Text-fallback mode (no SpeechRecognition support at all — e.g.
        // iOS Safari) — the call stays "active" and replies still play,
        // but there's no mic loop to start; the user types and submits
        // each turn instead (see the text-fallback form below).
        setCallStatus("idle");
      }
    });
  }, [speak, startMicrophoneListening, setCallStatus]);

  /**
   * Sequential, no overlapping async calls — each step below waits for
   * the previous one and logs before moving on, so a failure anywhere is
   * both visible (debug panel) and stops exactly where it happened
   * instead of leaving the UI in an ambiguous "did it hang or is it just
   * slow?" state.
   */
  const startCall = useCallback(() => {
    logDebug("[VOICE DEBUG 1] Starting call sequence...");
    if (!tenantId.trim()) {
      showToast("Enter a tenant id in the header before starting a voice call.", "error");
      return;
    }

    // Must run synchronously here, inside the click handler, before any
    // `await` — SpeechSynthesis/HTMLMediaElement/AudioContext unlocking
    // on iOS Safari all require being directly traceable to the gesture,
    // which an awaited call below would break.
    unlockSpeechSynthesis();
    unlockAudioPlayback();
    setDebugLog([]);
    elevenLabsFailureToastShownRef.current = false;
    setMicDenied(false);
    micAvailableRef.current = false;
    callActiveRef.current = true;
    setCallActive(true);
    setCallStatus("connecting");

    void (async () => {
      // --- Step 2: AudioContext + microphone permission ---
      try {
        const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
        if (AudioContextCtor) {
          const audioCtx = audioContextRef.current ?? new AudioContextCtor();
          audioContextRef.current = audioCtx;
          if (audioCtx.state === "suspended") {
            await audioCtx.resume();
          }
          logDebug(`AudioContext state: ${audioCtx.state}.`);
        } else {
          logDebug("AudioContext not available in this browser — continuing without it.");
        }
      } catch (error) {
        // Not fatal — this is a best-effort unlock, not every browser
        // strictly requires it, and unlockAudioPlayback/unlockSpeechSynthesis
        // above already cover the same gesture-unlock need another way.
        logDebug(`AudioContext error (non-fatal): ${describeError(error)}`);
      }

      const hasGetUserMedia = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
      if (!sttSupportedRef.current || !hasGetUserMedia) {
        // Capability gap (no SpeechRecognition at all — e.g. iOS Safari),
        // not a permission failure — nothing to request, proceed straight
        // to the greeting in text-fallback mode.
        logDebug("SpeechRecognition not supported in this browser — continuing in typed-input mode.");
        speakGreetingThenListen();
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        logDebug("Microfon activat cu succes...");
        // Only the grant was needed here, not the stream itself —
        // SpeechRecognition (startMicrophoneListening) opens its own
        // capture session separately.
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        micAvailableRef.current = true;
      } catch (error) {
        // Hard stop, per spec — a permission denial is actionable
        // ("allow the mic and try again"), unlike a capability gap, so it
        // gets a clear error state instead of a silent degrade.
        logDebug(`Eroare microfon: ${describeError(error)}`);
        micAvailableRef.current = false;
        setMicDenied(true);
        callActiveRef.current = false;
        setCallActive(false);
        setCallStatus("error");
        showToast("Eroare: Nu avem acces la microfon", "error");
        return;
      }

      // --- Step 3: greeting, then (via speakGreetingThenListen's own
      // continuation) Step 4: microphone listening ---
      speakGreetingThenListen();
    })();
  }, [tenantId, showToast, unlockSpeechSynthesis, unlockAudioPlayback, speakGreetingThenListen, setCallStatus, logDebug]);

  const submitTextFallback = useCallback(() => {
    const trimmed = textFallbackDraft.trim();
    if (!trimmed) return;
    setTextFallbackDraft("");
    void handleFinalTranscript(trimmed);
  }, [textFallbackDraft, handleFinalTranscript]);

  useEffect(() => {
    // Unmount safety net — a component tree change mid-call shouldn't
    // leave the mic listening or speech queued in the background.
    return () => {
      callActiveRef.current = false;
      recognitionRef.current?.stop();
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      audioRef.current?.pause();
      void audioContextRef.current?.close().catch(() => {
        /* already closed — nothing to do */
      });
    };
  }, []);

  // Romanian, matching the call's own spoken language — these are what
  // the tester sees on screen while the greeting/mic/reply cycle runs.
  const statusLabel: Record<CallStatus, string> = {
    idle: callActive && !sttSupported ? "Scrie mesajul tău" : "Niciun apel activ",
    connecting: "Se conectează…",
    listening: "Microfon activ",
    processing: "AI-ul se gândește…",
    speaking: "AI-ul vorbește…",
    error: "Eroare microfon",
  };

  const lastCallerTurn = [...turns].reverse().find((turn) => turn.role === "caller");
  const lastAgentTurn = [...turns].reverse().find((turn) => turn.role === "agent");

  const textFallbackForm = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitTextFallback();
      }}
      className="flex items-center gap-2"
    >
      <input
        value={textFallbackDraft}
        onChange={(event) => {
          setTextFallbackDraft(event.target.value);
        }}
        placeholder="Scrie ce ai spune la telefon…"
        disabled={status === "processing" || status === "speaking"}
        className="min-h-12 flex-1 rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base outline-none focus:border-violet-500 disabled:opacity-60 sm:text-sm dark:border-slate-700"
      />
      <button
        type="submit"
        disabled={!textFallbackDraft.trim() || status === "processing" || status === "speaking"}
        aria-label="Send"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-white transition active:scale-95 active:bg-violet-700 hover:bg-violet-500 disabled:opacity-50"
      >
        <Send className="h-4 w-4" />
      </button>
    </form>
  );

  const debugPanel = (
    <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-950 dark:border-slate-800">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Debug — Status: [{status.toUpperCase()}]</span>
      </div>
      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-emerald-400">
        {debugLog.length === 0 ? "Apasă „Începe Apel Vocal” pentru a începe…" : debugLog.join("\n")}
        <div ref={debugAnchorRef} />
      </pre>
    </div>
  );

  return (
    <div>
      {/* ================= Mobile call card (below md) ================= */}
      <div className="md:hidden">
        <div className="overflow-hidden rounded-2xl bg-gradient-to-b from-violet-600 to-violet-800 shadow-lg">
          <div className="flex flex-col items-center gap-4 px-6 pb-8 pt-10 text-center text-white">
            <div
              className={`flex h-24 w-24 items-center justify-center rounded-full bg-white/15 ring-4 ring-white/20 transition ${
                status === "listening" ? "animate-pulse ring-emerald-300/50" : ""
              }`}
            >
              <Bot className="h-11 w-11" />
            </div>

            <div>
              <p className="text-lg font-semibold">{callActive ? statusLabel[status] : "AI Booking Assistant"}</p>
              <p className="mt-1 text-sm text-violet-100">{callActive ? clientPhone : "Testează apelul fără Twilio"}</p>
            </div>

            <SpeakingWaveform active={status === "speaking"} />

            {interimText && <p className="max-w-xs text-sm italic text-violet-100">„{interimText}…”</p>}

            {!callActive ? (
              <button
                type="button"
                onClick={startCall}
                aria-label="Începe Apel Vocal"
                className="mt-2 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg transition active:scale-95 active:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Phone className="h-7 w-7" />
              </button>
            ) : (
              <button
                type="button"
                onClick={endCall}
                aria-label="Încheie Apel"
                className="mt-2 flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-white shadow-lg transition active:scale-95 active:bg-red-600"
              >
                <PhoneOff className="h-7 w-7" />
              </button>
            )}
            <p className="text-sm font-medium">{!callActive ? "Apelează Botul" : "Încheie Apel"}</p>
          </div>

          {!callActive && (
            <div className="border-t border-white/10 bg-black/10 px-6 py-4">
              <label className="flex items-center gap-2 text-xs text-violet-100">
                Caller phone
                <input
                  value={clientPhone}
                  onChange={(event) => {
                    setClientPhone(event.target.value);
                  }}
                  className="min-h-10 flex-1 rounded-md border border-white/20 bg-white/10 px-2 py-1 text-sm text-white outline-none placeholder:text-violet-200 focus:border-white/50"
                />
              </label>
            </div>
          )}
        </div>

        {debugPanel}

        {!ttsSupported && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            This browser doesn't support the SpeechSynthesis fallback — replies still play via ElevenLabs when that's reachable, but won't be read aloud if it isn't.
          </div>
        )}
        {micDenied && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            Eroare: Nu avem acces la microfon. Permite accesul la microfon în setările browserului și încearcă din nou.
          </div>
        )}
        {callActive && !sttSupported && (
          <div className="mt-3 space-y-2 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
            <p className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <Keyboard className="h-3.5 w-3.5" />
              This browser can't listen (no SpeechRecognition — normal on iOS Safari), so type your side of the call instead. Replies are still spoken aloud.
            </p>
            {textFallbackForm}
          </div>
        )}

        {(lastCallerTurn ?? lastAgentTurn) && (
          <div className="mt-4 space-y-2">
            {lastCallerTurn && (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-violet-600 px-3.5 py-2 text-sm leading-relaxed text-white">{lastCallerTurn.text}</div>
              </div>
            )}
            {lastAgentTurn && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl bg-slate-100 px-3.5 py-2 text-sm leading-relaxed text-slate-800 dark:bg-slate-800 dark:text-slate-100">
                  {lastAgentTurn.text}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ================= Desktop/tablet transcript view (md+) ================= */}
      <div className="hidden gap-4 md:grid md:grid-cols-[2fr_1fr]">
        <div className="flex h-[32rem] flex-col rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              Caller phone
              <input
                value={clientPhone}
                onChange={(event) => {
                  setClientPhone(event.target.value);
                }}
                disabled={callActive}
                className="min-h-10 w-36 rounded-md border border-slate-300 bg-transparent px-2 py-1 text-xs text-slate-900 outline-none focus:border-violet-500 disabled:opacity-60 dark:border-slate-700 dark:text-slate-100"
              />
            </label>
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
              {status === "listening" && <Mic className="h-3.5 w-3.5 animate-pulse text-emerald-500" />}
              {status === "speaking" && <Volume2 className="h-3.5 w-3.5 animate-pulse text-violet-500" />}
              {statusLabel[status]}
            </div>
          </div>

          {!ttsSupported && (
            <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              This browser doesn't support the SpeechSynthesis fallback — replies still play via ElevenLabs when that's reachable, but won't be read aloud if it isn't.
            </div>
          )}
          {micDenied && (
            <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Eroare: Nu avem acces la microfon. Permite accesul la microfon în setările browserului și încearcă din nou.
            </div>
          )}
          {!sttSupported && (
            <div className="flex items-start gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300">
              <Keyboard className="mt-0.5 h-4 w-4 shrink-0" />
              This browser doesn't support SpeechRecognition (Chrome/Edge only — expected on Safari). Type instead; replies are still spoken aloud.
            </div>
          )}

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {turns.length === 0 && (
              <p className="text-sm text-slate-400 dark:text-slate-500">
                Start a call, then speak in Romanian — e.g. „Aș vrea o programare mâine după-amiază.”
              </p>
            )}
            {turns.map((turn) => (
              <div key={turn.id} className={`flex gap-2 ${turn.role === "caller" ? "justify-end" : "justify-start"}`}>
                {turn.role === "agent" && (
                  <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-300">
                    <Bot className="h-4 w-4" />
                  </div>
                )}
                <div
                  className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                    turn.role === "caller" ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100"
                  }`}
                >
                  {turn.text}
                </div>
                {turn.role === "caller" && (
                  <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                    <User className="h-4 w-4" />
                  </div>
                )}
              </div>
            ))}
            {interimText && (
              <div className="flex justify-end gap-2">
                <div className="max-w-[75%] rounded-2xl bg-violet-600/40 px-3.5 py-2 text-sm italic leading-relaxed text-white">{interimText}…</div>
              </div>
            )}
            <div ref={scrollAnchorRef} />
          </div>

          {callActive && !sttSupported && <div className="border-t border-slate-200 p-3 dark:border-slate-800">{textFallbackForm}</div>}

          <div className="flex items-center justify-center border-t border-slate-200 p-4 dark:border-slate-800">
            {!callActive ? (
              <button
                type="button"
                onClick={startCall}
                className="flex h-12 items-center gap-2 rounded-full bg-emerald-600 px-6 text-sm font-semibold text-white shadow-sm transition active:scale-95 active:bg-emerald-700 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Phone className="h-4 w-4" />
                Începe Apel Vocal
              </button>
            ) : (
              <button
                type="button"
                onClick={endCall}
                className="flex h-12 items-center gap-2 rounded-full bg-red-600 px-6 text-sm font-semibold text-white shadow-sm transition active:scale-95 active:bg-red-700 hover:bg-red-500"
              >
                <PhoneOff className="h-4 w-4" />
                Încheie Apel
              </button>
            )}
          </div>

          {debugPanel}
        </div>

        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">How this works</h3>
            <ul className="space-y-2 text-xs text-slate-500 dark:text-slate-400">
              <li className="flex gap-2">
                <Mic className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Your mic is transcribed locally by the browser (SpeechRecognition, ro-RO) — no Twilio, no audio ever leaves your machine as audio.
              </li>
              <li className="flex gap-2">
                <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                The transcript hits the same booking pipeline a real call uses, tagged as an <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">ai_voice</code> turn.
              </li>
              <li className="flex gap-2">
                <Volume2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                The reply is read back in the real ElevenLabs voice — the same one used on actual phone calls — before the mic reopens for your next turn. Falls back to the browser's own SpeechSynthesis if ElevenLabs isn't reachable.
              </li>
            </ul>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500">
              <MicOff className="h-3 w-3" />
              Voice input needs mic permission and Chrome/Edge — Safari (incl. iOS) falls back to typed input automatically.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
