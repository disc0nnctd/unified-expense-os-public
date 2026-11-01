import { useEffect, useRef, useState } from "react";
import { isVoiceSupported, startListening, type VoiceSession } from "../lib/voiceInput";

type Props = {
  onTranscript: (transcript: string) => void;
  setError: (message: string | null) => void;
  compact?: boolean;
};

// Push-to-talk mic button. Shows live partial transcripts while listening and
// hands the final transcript to the caller (who parses + prefills — never
// saves). Hidden entirely where no speech engine exists.
export default function VoiceCaptureButton({ onTranscript, setError, compact = true }: Props) {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const sessionRef = useRef<VoiceSession | null>(null);

  useEffect(() => {
    return () => sessionRef.current?.stop();
  }, []);

  if (!isVoiceSupported()) {
    return null;
  }

  async function toggle() {
    if (listening) {
      sessionRef.current?.stop();
      return;
    }
    setError(null);
    setPartial("");
    setListening(true);
    sessionRef.current = await startListening({
      onPartial: (transcript) => setPartial(transcript),
      onFinal: (transcript) => {
        setPartial("");
        onTranscript(transcript);
      },
      onError: (message) => setError(message),
      onEnd: () => {
        setListening(false);
        setPartial("");
        sessionRef.current = null;
      },
    });
  }

  return (
    <>
      <button
        type="button"
        className={`secondary${compact ? " compact" : ""}${listening ? " listening" : ""}`}
        aria-pressed={listening}
        aria-label={listening ? "Stop listening" : "Speak an expense"}
        onClick={() => void toggle()}
      >
        {listening ? "◼ Listening…" : "🎤 Speak"}
      </button>
      {listening && partial ? (
        <span className="share-hint wide" aria-live="polite">
          “{partial}”
        </span>
      ) : null}
    </>
  );
}
