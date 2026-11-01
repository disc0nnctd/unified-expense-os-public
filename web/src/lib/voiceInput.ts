// Speech-to-text bridge (unified-expense-os-mi5). Two engines, one API:
//
// - Android (Capacitor shell): the custom `VoiceInput` plugin wraps the
//   platform SpeechRecognizer with EXTRA_PREFER_OFFLINE, so recognition uses
//   Google's on-device models where available and audio never has to leave
//   the phone — same privacy posture as SMS auto-read. The WebView does NOT
//   implement the Web Speech API, so the plugin is mandatory there.
// - Browsers with the Web Speech API (Chrome/Safari): webkitSpeechRecognition.
//   Chrome's implementation is server-backed; surfaced in the Settings copy.
//
// Everything degrades to "unsupported" (mic button hidden, typing still
// works) rather than erroring. Transcripts go to the deterministic grammar
// first — see lib/voiceGrammar.ts.
import { Capacitor, registerPlugin, type PermissionState, type PluginListenerHandle } from "@capacitor/core";

type VoicePermissionStatus = { microphone: PermissionState };

interface VoiceInputPlugin {
  available(): Promise<{ available: boolean }>;
  checkPermissions(): Promise<VoicePermissionStatus>;
  requestPermissions(): Promise<VoicePermissionStatus>;
  start(options: { language?: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(
    eventName: "partialResult" | "finalResult" | "listeningState",
    handler: (payload: { transcript?: string; state?: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(eventName: "error", handler: (payload: { message: string }) => void): Promise<PluginListenerHandle>;
}

const VoiceInput = registerPlugin<VoiceInputPlugin>("VoiceInput");

type WebSpeechRecognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function webSpeechCtor(): (new () => WebSpeechRecognition) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => WebSpeechRecognition;
    webkitSpeechRecognition?: new () => WebSpeechRecognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isVoiceSupported(): boolean {
  if (Capacitor.getPlatform() === "android") {
    return true; // plugin availability is confirmed on start; button shows.
  }
  return webSpeechCtor() !== null;
}

export type VoiceSession = {
  stop: () => void;
};

export type VoiceCallbacks = {
  onPartial: (transcript: string) => void;
  onFinal: (transcript: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
};

// Start listening. Returns a session whose stop() ends recognition early
// (the engine still delivers whatever final transcript it has).
export async function startListening(callbacks: VoiceCallbacks, language = "en-IN"): Promise<VoiceSession> {
  if (Capacitor.getPlatform() === "android") {
    return startNative(callbacks, language);
  }
  return startWebSpeech(callbacks, language);
}

async function startNative(callbacks: VoiceCallbacks, language: string): Promise<VoiceSession> {
  const { available } = await VoiceInput.available().catch(() => ({ available: false }));
  if (!available) {
    callbacks.onError("Speech recognition isn't available on this device.");
    callbacks.onEnd();
    return { stop: () => undefined };
  }
  let status = await VoiceInput.checkPermissions();
  if (status.microphone !== "granted") {
    status = await VoiceInput.requestPermissions();
  }
  if (status.microphone !== "granted") {
    callbacks.onError("Microphone permission was not granted.");
    callbacks.onEnd();
    return { stop: () => undefined };
  }
  const handles: PluginListenerHandle[] = [];
  let done = false;
  const cleanup = () => {
    if (done) {
      return;
    }
    done = true;
    for (const handle of handles) {
      void handle.remove();
    }
    callbacks.onEnd();
  };
  handles.push(
    await VoiceInput.addListener("partialResult", (payload) => {
      if (payload.transcript) {
        callbacks.onPartial(payload.transcript);
      }
    }),
  );
  handles.push(
    await VoiceInput.addListener("finalResult", (payload) => {
      if (payload.transcript) {
        callbacks.onFinal(payload.transcript);
      }
      cleanup();
    }),
  );
  handles.push(
    await VoiceInput.addListener("error", (payload) => {
      callbacks.onError(payload.message || "Speech recognition failed.");
      cleanup();
    }),
  );
  await VoiceInput.start({ language });
  return {
    stop: () => {
      void VoiceInput.stop().catch(() => undefined);
    },
  };
}

function startWebSpeech(callbacks: VoiceCallbacks, language: string): VoiceSession {
  const Ctor = webSpeechCtor();
  if (!Ctor) {
    callbacks.onError("Speech recognition isn't supported in this browser.");
    callbacks.onEnd();
    return { stop: () => undefined };
  }
  const recognition = new Ctor();
  recognition.lang = language;
  recognition.interimResults = true;
  recognition.continuous = false;
  let finalTranscript = "";
  recognition.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) {
        finalTranscript += result[0].transcript;
      } else {
        interim += result[0].transcript;
      }
    }
    if (interim) {
      callbacks.onPartial(finalTranscript + interim);
    }
  };
  recognition.onerror = (event) => {
    if (event.error !== "aborted" && event.error !== "no-speech") {
      callbacks.onError(`Speech recognition failed (${event.error}).`);
    }
  };
  recognition.onend = () => {
    if (finalTranscript.trim()) {
      callbacks.onFinal(finalTranscript.trim());
    }
    callbacks.onEnd();
  };
  recognition.start();
  return {
    stop: () => recognition.stop(),
  };
}
