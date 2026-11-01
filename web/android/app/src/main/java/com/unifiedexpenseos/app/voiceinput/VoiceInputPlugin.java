package com.unifiedexpenseos.app.voiceinput;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Speech-to-text for voice expense capture (unified-expense-os-mi5), wrapping
 * the platform SpeechRecognizer. EXTRA_PREFER_OFFLINE requests the on-device
 * recognition models where available, matching the SMS auto-read privacy
 * posture: audio is transcribed locally and only the transcript reaches the
 * JS layer, where the deterministic grammar (web/src/lib/voiceGrammar.ts)
 * turns it into an assist-only draft. Nothing is auto-written to the ledger.
 *
 * The Capacitor WebView does not implement the Web Speech API, so this
 * plugin is the only speech path in the Android shell.
 */
@CapacitorPlugin(
    name = "VoiceInput",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class VoiceInputPlugin extends Plugin {

    private SpeechRecognizer recognizer;

    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermsCallback");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void micPermsCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            doStart(call);
        } else {
            call.reject("Microphone permission was not granted.");
        }
    }

    private void doStart(PluginCall call) {
        String language = call.getString("language", "en-IN");
        // SpeechRecognizer must be created and driven on the main thread.
        getActivity().runOnUiThread(() -> {
            try {
                stopInternal();
                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                recognizer.setRecognitionListener(new RecognitionListener() {
                    @Override
                    public void onPartialResults(Bundle partialResults) {
                        emitTranscript("partialResult", partialResults);
                    }

                    @Override
                    public void onResults(Bundle results) {
                        emitTranscript("finalResult", results);
                        stopInternal();
                    }

                    @Override
                    public void onError(int error) {
                        // NO_MATCH / SPEECH_TIMEOUT are ordinary "heard nothing"
                        // outcomes — end quietly with an empty final result.
                        if (error == SpeechRecognizer.ERROR_NO_MATCH
                            || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                            JSObject payload = new JSObject();
                            payload.put("transcript", "");
                            notifyListeners("finalResult", payload);
                        } else {
                            JSObject payload = new JSObject();
                            payload.put("message", describeError(error));
                            notifyListeners("error", payload);
                        }
                        stopInternal();
                    }

                    @Override public void onReadyForSpeech(Bundle params) { }
                    @Override public void onBeginningOfSpeech() { }
                    @Override public void onRmsChanged(float rmsdB) { }
                    @Override public void onBufferReceived(byte[] buffer) { }
                    @Override public void onEndOfSpeech() { }
                    @Override public void onEvent(int eventType, Bundle params) { }
                });

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                // Prefer local models so audio stays on the phone (falls back to
                // the network recognizer only when no offline pack is installed).
                intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
                recognizer.startListening(intent);
                call.resolve();
            } catch (Exception error) {
                call.reject("Failed to start speech recognition: " + error.getMessage(), error);
            }
        });
    }

    private void emitTranscript(String event, Bundle bundle) {
        if (bundle == null) {
            return;
        }
        ArrayList<String> texts = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (texts == null || texts.isEmpty()) {
            return;
        }
        JSObject payload = new JSObject();
        payload.put("transcript", texts.get(0));
        notifyListeners(event, payload);
    }

    private String describeError(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "Audio recording failed.";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "Microphone permission was not granted.";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "Speech service needs a network and couldn't reach it.";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "Speech recognizer is busy — try again.";
            default:
                return "Speech recognition failed (code " + error + ").";
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) {
                try {
                    recognizer.stopListening();
                } catch (Exception ignored) {
                    // Stopping an idle recognizer is harmless.
                }
            }
            call.resolve();
        });
    }

    private void stopInternal() {
        if (recognizer != null) {
            try {
                recognizer.destroy();
            } catch (Exception ignored) {
                // Already destroyed.
            }
            recognizer = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal();
        super.handleOnDestroy();
    }
}
