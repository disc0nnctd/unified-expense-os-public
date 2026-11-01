// Thin bridge to the custom Android `SmsReader` Capacitor plugin
// (web/android/.../smsreader/SmsReaderPlugin.java). Every export degrades to a
// safe no-op on web and iOS so the rest of the app never branches on platform.
//
// Privacy posture: reading SMS is a sensitive permission, so this is strictly
// opt-in (the user taps "Read payment SMS") and the plugin only ever returns
// message text back to the on-device deterministic parser in lib/capture.ts —
// nothing is uploaded, and no suggestion reaches the ledger without the user
// reviewing and saving it. See docs/design/sms-email-auto-read.md.
import { Capacitor, registerPlugin, type PermissionState } from "@capacitor/core";
import type { SmsMessage } from "./capture";

type SmsPermissionStatus = { sms: PermissionState };

interface SmsReaderPlugin {
  checkPermissions(): Promise<SmsPermissionStatus>;
  requestPermissions(): Promise<SmsPermissionStatus>;
  // Reads the SMS inbox (READ_SMS). `sinceMillis` is an epoch-millis lower
  // bound; `limit` caps the row count. Native returns newest-first.
  readRecent(options: { sinceMillis?: number; limit?: number }): Promise<{ messages: SmsMessage[] }>;
}

const SmsReader = registerPlugin<SmsReaderPlugin>("SmsReader");

// SMS reading is Android-only; iOS forbids third-party inbox access entirely.
export function isSmsAutoReadSupported(): boolean {
  return Capacitor.getPlatform() === "android";
}

// Current grant state, without ever showing a prompt. "unsupported" lets the
// UI hide the affordance entirely off Android.
export async function checkSmsPermission(): Promise<PermissionState | "unsupported"> {
  if (!isSmsAutoReadSupported()) {
    return "unsupported";
  }
  try {
    const status = await SmsReader.checkPermissions();
    return status.sms;
  } catch {
    return "denied";
  }
}

// Shows the OS permission dialog (a no-op returning the current state if the
// user already answered — Android never re-prompts after a hard denial).
// Resolves to true only when SMS reading is actually usable.
export async function requestSmsPermission(): Promise<boolean> {
  if (!isSmsAutoReadSupported()) {
    return false;
  }
  try {
    let status = await SmsReader.checkPermissions();
    if (status.sms !== "granted") {
      status = await SmsReader.requestPermissions();
    }
    return status.sms === "granted";
  } catch {
    return false;
  }
}

// Requests the SMS permission (if not already granted) and returns the recent
// inbox for the deterministic parser. Rejects if the user denies permission.
// Returns [] on unsupported platforms so callers can hide the affordance.
export async function readRecentSms(days = 3, limit = 100): Promise<SmsMessage[]> {
  if (!isSmsAutoReadSupported()) {
    return [];
  }
  let status = await SmsReader.checkPermissions();
  if (status.sms !== "granted") {
    status = await SmsReader.requestPermissions();
  }
  if (status.sms !== "granted") {
    throw new Error("SMS permission was not granted.");
  }
  const sinceMillis = Date.now() - days * 24 * 60 * 60 * 1000;
  const { messages } = await SmsReader.readRecent({ sinceMillis, limit });
  return messages;
}
