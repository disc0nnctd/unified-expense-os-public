// Thin wrapper over the Capacitor native plugins. Every call is a no-op on the
// web build (guarded by isNativePlatform), so the rest of the app never has to
// branch on platform. Failures in cosmetic native calls are swallowed — they
// must never block the app from booting.
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

// Configure system chrome once at startup. The app header (--nav) is dark in
// both colour schemes, so light status-bar icons (Style.Dark) read correctly.
// Overlaying the webview lets the existing env(safe-area-inset-*) CSS extend
// the header under the status bar for a true edge-to-edge look.
export async function initNativeShell(): Promise<void> {
  if (!isNative()) {
    return;
  }
  try {
    await StatusBar.setOverlaysWebView({ overlay: true });
    await StatusBar.setStyle({ style: Style.Dark });
    if (Capacitor.getPlatform() === "android") {
      await StatusBar.setBackgroundColor({ color: "#00000000" });
    }
  } catch {
    // Status bar styling is cosmetic; never fatal.
  }
  try {
    // Resize the webview so the sticky bottom actions clear the keyboard.
    await Keyboard.setResizeMode({ mode: KeyboardResize.Native });
  } catch {
    // Keyboard plugin unavailable (e.g. iOS-only quirks) — ignore.
  }
}

export async function hideSplash(): Promise<void> {
  if (!isNative()) {
    return;
  }
  try {
    await SplashScreen.hide();
  } catch {
    // Splash may already be hidden.
  }
}

// Register the Android hardware back button. `handler` returns true when it
// consumed the press (e.g. navigated a screen back); when it returns false we
// let the OS close the app, matching native expectations.
export function registerBackButton(handler: () => boolean): () => void {
  if (!isNative()) {
    return () => undefined;
  }
  const listener = CapacitorApp.addListener("backButton", () => {
    const handled = handler();
    if (!handled) {
      void CapacitorApp.exitApp();
    }
  });
  return () => {
    void listener.then((sub) => sub.remove());
  };
}

// Called when the app returns to the foreground — a good moment to re-sync.
export function registerResume(handler: () => void): () => void {
  if (!isNative()) {
    return () => undefined;
  }
  const listener = CapacitorApp.addListener("resume", handler);
  return () => {
    void listener.then((sub) => sub.remove());
  };
}

export async function tapHaptic(): Promise<void> {
  if (!isNative()) {
    return;
  }
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Haptics unsupported — ignore.
  }
}
