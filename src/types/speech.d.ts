/**
 * TypeScript's bundled lib.dom.d.ts ships the *supporting* Web Speech API
 * types (SpeechRecognitionEvent, SpeechRecognitionErrorEvent,
 * SpeechRecognitionResultList, ...) but not the `SpeechRecognition`
 * interface/constructor itself — it's still non-standard enough that TS
 * doesn't include it. This fills exactly that gap so
 * VoiceCallSimulator.tsx can use it without `any`.
 *
 * Covers only the surface actually used: continuous dictation with
 * interim results off, start/stop, and the result/error/end handlers.
 * Not a general-purpose ambient definition for the whole spec.
 */
interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((event: Event) => void) | null;
  onstart: ((event: Event) => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
  // Legacy vendor-prefixed AudioContext — Safari shipped this long before
  // adopting the unprefixed name; lib.dom.d.ts only has the latter.
  webkitAudioContext?: typeof AudioContext;
}
