package com.unifiedexpenseos.app.smsreader;

import android.Manifest;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Telephony;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Reads payment SMS on-device and hands the raw text back to the JS layer,
 * which parses it deterministically (web/src/lib/capture.ts) into an
 * assist-only expense suggestion. This plugin never uploads anything and never
 * writes to the ledger — it only surfaces inbox text the user explicitly asked
 * for. See docs/design/sms-email-auto-read.md.
 *
 * Only READ_SMS is requested, and only for the manual scan — there is no
 * background or live listener, so the app never asks for more access than the
 * button the user actually pressed.
 */
@CapacitorPlugin(
    name = "SmsReader",
    permissions = {
        @Permission(
            alias = "sms",
            strings = { Manifest.permission.READ_SMS }
        )
    }
)
public class SmsReaderPlugin extends Plugin {

    @PluginMethod
    public void readRecent(PluginCall call) {
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            requestPermissionForAlias("sms", call, "smsPermsCallback");
            return;
        }
        doReadRecent(call);
    }

    @PermissionCallback
    private void smsPermsCallback(PluginCall call) {
        if (getPermissionState("sms") == PermissionState.GRANTED) {
            doReadRecent(call);
        } else {
            call.reject("SMS permission was not granted.");
        }
    }

    private void doReadRecent(PluginCall call) {
        long sinceMillis = call.getLong("sinceMillis", 0L);
        int limit = call.getInt("limit", 100);

        JSArray messages = new JSArray();
        Uri uri = Telephony.Sms.Inbox.CONTENT_URI;
        String[] projection = { Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE };
        String selection = sinceMillis > 0 ? (Telephony.Sms.DATE + " >= ?") : null;
        String[] selectionArgs = sinceMillis > 0 ? new String[] { String.valueOf(sinceMillis) } : null;
        // The SMS provider is SQLite-backed; a trailing LIMIT in the sort-order
        // clause caps rows without pulling the whole inbox into the cursor.
        String sortOrder = Telephony.Sms.DATE + " DESC LIMIT " + Math.max(1, limit);

        Cursor cursor = null;
        try {
            cursor = getContext().getContentResolver().query(uri, projection, selection, selectionArgs, sortOrder);
            if (cursor != null) {
                int addressIndex = cursor.getColumnIndex(Telephony.Sms.ADDRESS);
                int bodyIndex = cursor.getColumnIndex(Telephony.Sms.BODY);
                int dateIndex = cursor.getColumnIndex(Telephony.Sms.DATE);
                while (cursor.moveToNext()) {
                    JSObject message = new JSObject();
                    message.put("sender", addressIndex >= 0 ? cursor.getString(addressIndex) : "");
                    message.put("body", bodyIndex >= 0 ? cursor.getString(bodyIndex) : "");
                    message.put("receivedAt", dateIndex >= 0 ? cursor.getLong(dateIndex) : 0L);
                    messages.put(message);
                }
            }
        } catch (Exception error) {
            call.reject("Failed to read SMS inbox: " + error.getMessage(), error);
            return;
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }

        JSObject result = new JSObject();
        result.put("messages", messages);
        call.resolve(result);
    }
}
