package com.unifiedexpenseos.app.localllm;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mediapipe.tasks.genai.llminference.LlmInference;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * On-device small-model inference for assist parsing/chat
 * (unified-expense-os-iqa), via MediaPipe LLM Inference. Model-agnostic: it
 * runs whatever compatible bundle (.task/.litertlm — Gemma 3 1B int4 is the
 * recommended default; converted Llama/Phi bundles also work) the user
 * imports through the system file picker. The picked file is copied into
 * app-private storage, so no storage permission is ever requested.
 *
 * Privacy/assist posture: prompts are built by the JS layer from chat text
 * and member NAMES only, inference runs entirely on the phone, and the
 * output only ever becomes a draft the user reviews — this plugin has no
 * access to the ledger and cannot write to it.
 */
@CapacitorPlugin(name = "LocalLlm")
public class LocalLlmPlugin extends Plugin {

    private static final String PREFS = "localllm";
    private static final String PREF_MODEL_NAME = "modelName";
    // Legacy single-download slot (pre-parallel); folded into the map below
    // on first read so an in-flight download survives the upgrade.
    private static final String PREF_BG_DOWNLOAD_ID = "bgDownloadId";
    private static final String PREF_BG_FILE_NAME = "bgFileName";
    // JSON object {downloadId: fileName} — several models can download at
    // once (DownloadManager runs them concurrently; we just track the set).
    private static final String PREF_BG_DOWNLOADS = "bgDownloads";
    private static final String MODELS_DIR = "llm-models";
    private static final String BG_DOWNLOADS_DIR = "llm-downloads";
    private static final int DEFAULT_MAX_TOKENS = 512;

    // LlmInference calls are blocking and heavy; serialize them off the UI
    // and bridge threads on a single worker so loads/generates never overlap.
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    // Downloads run on their own worker so a long fetch never blocks
    // load/generate, with a cancel flag the JS layer can flip.
    private final ExecutorService downloadExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean downloadCancelled = new AtomicBoolean(false);
    private LlmInference llm;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, 0);
    }

    private File modelFile() {
        String name = prefs().getString(PREF_MODEL_NAME, null);
        if (name == null) {
            return null;
        }
        File file = new File(new File(getContext().getFilesDir(), MODELS_DIR), name);
        return file.exists() ? file : null;
    }

    /** All tracked background downloads (id → target file name). Migrates
     *  the legacy single-slot prefs into the map on first read. */
    private java.util.LinkedHashMap<Long, String> trackedDownloads() {
        java.util.LinkedHashMap<Long, String> map = new java.util.LinkedHashMap<>();
        long legacyId = prefs().getLong(PREF_BG_DOWNLOAD_ID, -1);
        if (legacyId >= 0) {
            map.put(legacyId, prefs().getString(PREF_BG_FILE_NAME, "model.task"));
        }
        String raw = prefs().getString(PREF_BG_DOWNLOADS, null);
        if (raw != null) {
            try {
                org.json.JSONObject json = new org.json.JSONObject(raw);
                java.util.Iterator<String> keys = json.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    map.put(Long.parseLong(key), json.optString(key, "model.task"));
                }
            } catch (Exception ignored) {
                // Corrupt tracking state is not worth crashing over; the
                // orphan scan in getStatus recovers any finished file.
            }
        }
        if (legacyId >= 0) {
            saveTrackedDownloads(map);
        }
        return map;
    }

    private void saveTrackedDownloads(java.util.Map<Long, String> map) {
        org.json.JSONObject json = new org.json.JSONObject();
        try {
            for (java.util.Map.Entry<Long, String> entry : map.entrySet()) {
                json.put(String.valueOf(entry.getKey()), entry.getValue());
            }
        } catch (Exception ignored) {
            // JSONObject.put only throws on null/NaN keys — can't happen here.
        }
        prefs().edit()
            .remove(PREF_BG_DOWNLOAD_ID)
            .remove(PREF_BG_FILE_NAME)
            .putString(PREF_BG_DOWNLOADS, json.toString())
            .apply();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        File model = modelFile();
        JSObject result = new JSObject();
        result.put("supported", true);
        result.put("modelPath", model != null ? model.getAbsolutePath() : null);
        result.put("modelName", model != null ? model.getName() : null);
        result.put("loaded", llm != null);
        com.getcapacitor.JSArray models = new com.getcapacitor.JSArray();
        File dir = new File(getContext().getFilesDir(), MODELS_DIR);
        File[] files = dir.listFiles();
        if (files != null) {
            for (File file : files) {
                JSObject row = new JSObject();
                row.put("name", file.getName());
                row.put("sizeBytes", file.length());
                row.put("current", model != null && file.getName().equals(model.getName()));
                models.put(row);
            }
        }
        result.put("models", models);
        // Orphan scan: a background download that finished while the app was
        // away (or whose DownloadManager record is gone — cleared shade,
        // reinstall) leaves its file in the staging dir with nothing tracking
        // it. Surface those so the UI can offer recovery instead of a
        // redownload. Files still being downloaded (tracked ids) are skipped —
        // DownloadManager writes partials into this same staging dir.
        com.getcapacitor.JSArray pending = new com.getcapacitor.JSArray();
        java.util.Set<String> inFlight = new java.util.HashSet<>(trackedDownloads().values());
        File staging = getContext().getExternalFilesDir(BG_DOWNLOADS_DIR);
        File[] staged = staging != null ? staging.listFiles() : null;
        if (staged != null) {
            for (File file : staged) {
                if (file.isFile() && file.length() > 0 && !inFlight.contains(file.getName())) {
                    JSObject row = new JSObject();
                    row.put("name", file.getName());
                    row.put("sizeBytes", file.length());
                    pending.put(row);
                }
            }
        }
        result.put("pendingFiles", pending);
        call.resolve(result);
    }

    /** Adopt an orphaned staged download as an installed model. If the file
     *  was actually truncated, loading it will fail and it can be deleted. */
    @PluginMethod
    public void recoverDownloadedFile(PluginCall call) {
        String name = call.getString("name", "");
        if (name == null || name.isEmpty()) {
            call.reject("name is required.");
            return;
        }
        downloadExecutor.execute(() -> {
            try {
                File source = new File(getContext().getExternalFilesDir(BG_DOWNLOADS_DIR), name);
                finalizeDownloadedModel(source, name);
                JSObject payload = new JSObject();
                payload.put("modelName", name);
                call.resolve(payload);
            } catch (Exception error) {
                call.reject("Couldn't recover the file: " + error.getMessage());
            }
        });
    }

    @PluginMethod
    public void discardDownloadedFile(PluginCall call) {
        String name = call.getString("name", "");
        if (name == null || name.isEmpty()) {
            call.reject("name is required.");
            return;
        }
        File source = new File(getContext().getExternalFilesDir(BG_DOWNLOADS_DIR), name);
        //noinspection ResultOfMethodCallIgnored
        source.delete();
        call.resolve();
    }

    /** Switch the current model among the installed files. Unloads any
     *  loaded engine; the caller loads explicitly afterwards. */
    @PluginMethod
    public void selectModel(PluginCall call) {
        String modelName = call.getString("modelName", "");
        if (modelName == null || modelName.isEmpty()) {
            call.reject("modelName is required.");
            return;
        }
        File file = new File(new File(getContext().getFilesDir(), MODELS_DIR), modelName);
        if (!file.exists()) {
            call.reject("No installed model named " + modelName + ".");
            return;
        }
        executor.execute(() -> {
            closeLlm();
            prefs().edit().putString(PREF_MODEL_NAME, modelName).apply();
            call.resolve();
        });
    }

    @PluginMethod
    public void getStorageInfo(PluginCall call) {
        File filesDir = getContext().getFilesDir();
        File model = modelFile();
        JSObject result = new JSObject();
        result.put("freeBytes", filesDir.getUsableSpace());
        result.put("modelSizeBytes", model != null ? model.length() : null);
        call.resolve(result);
    }

    /**
     * Streams a model bundle straight into app-private storage with progress
     * events, so users don't need to route half-gigabyte files through the
     * Downloads folder + SAF import. Optional bearer token supports gated
     * hosts (e.g. Hugging Face's Gemma license gate). Free space is checked
     * against Content-Length before any bytes are written.
     */
    @PluginMethod
    public void downloadModel(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("A valid model URL is required.");
            return;
        }
        String fileName = call.getString("fileName", null);
        if (fileName == null || fileName.isEmpty()) {
            String tail = url.substring(url.lastIndexOf('/') + 1);
            int query = tail.indexOf('?');
            fileName = (query >= 0 ? tail.substring(0, query) : tail);
        }
        String safeName = fileName.replaceAll("[^A-Za-z0-9._-]", "_");
        String authToken = call.getString("authToken", null);
        String finalUrl = url;
        downloadCancelled.set(false);
        downloadExecutor.execute(() -> doDownload(call, finalUrl, safeName, authToken));
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        downloadCancelled.set(true);
        call.resolve();
    }

    /**
     * Background download via the system DownloadManager: survives the app
     * being backgrounded or killed and shows a system-owned progress
     * notification (no notification permission needed). Redirects are
     * resolved here first — with the auth token when the host is gated — so
     * the URL handed to DownloadManager is the final CDN URL and needs no
     * Authorization header (signed CDN URLs reject extra auth).
     */
    @PluginMethod
    public void downloadModelInBackground(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("A valid model URL is required.");
            return;
        }
        String fileName = call.getString("fileName", null);
        if (fileName == null || fileName.isEmpty()) {
            String tail = url.substring(url.lastIndexOf('/') + 1);
            int query = tail.indexOf('?');
            fileName = (query >= 0 ? tail.substring(0, query) : tail);
        }
        String safeName = fileName.replaceAll("[^A-Za-z0-9._-]", "_");
        String authToken = call.getString("authToken", null);
        String requestUrl = url;
        downloadExecutor.execute(() -> {
            try {
                if (trackedDownloads().containsValue(safeName)) {
                    call.reject(safeName + " is already downloading.");
                    return;
                }
                ResolvedUrl resolved = resolveFinalUrl(requestUrl, authToken);
                if (resolved.errorMessage != null) {
                    call.reject(resolved.errorMessage);
                    return;
                }
                long free = getContext().getFilesDir().getUsableSpace();
                long cushion = 200L * 1024 * 1024;
                if (resolved.contentLength > 0 && resolved.contentLength + cushion > free) {
                    call.reject("Not enough storage: model needs " + (resolved.contentLength / (1024 * 1024))
                        + " MB plus headroom, " + (free / (1024 * 1024)) + " MB free.");
                    return;
                }
                // Clear any stale partial from a previous background attempt.
                File stale = new File(getContext().getExternalFilesDir(BG_DOWNLOADS_DIR), safeName);
                if (stale.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    stale.delete();
                }
                // Ungated downloads enqueue the ORIGINAL URL: signed CDN links
                // expire (~1 h on HF) and a paused/resumed transfer against a
                // pre-resolved link 403s. DownloadManager re-follows the
                // redirect chain on every retry, getting a fresh signature.
                // Gated downloads must keep the pre-resolved URL (the auth
                // token can't ride along to the CDN), so very slow gated
                // transfers may need a restart after an expiry — surfaced in
                // the failure message.
                boolean tokenless = authToken == null || authToken.isEmpty();
                String enqueueUrl = tokenless ? requestUrl : resolved.finalUrl;
                DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(enqueueUrl));
                request.setTitle("Expense OS — AI model");
                request.setDescription(safeName);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
                // Be explicit: some OEM builds queue large transfers "for
                // Wi-Fi" unless the request opts into metered networks.
                request.setAllowedOverMetered(true);
                request.setAllowedOverRoaming(true);
                request.setDestinationInExternalFilesDir(getContext(), BG_DOWNLOADS_DIR, safeName);
                long downloadId = manager.enqueue(request);
                java.util.LinkedHashMap<Long, String> tracked = trackedDownloads();
                tracked.put(downloadId, safeName);
                saveTrackedDownloads(tracked);
                JSObject payload = new JSObject();
                payload.put("downloadId", downloadId);
                payload.put("fileName", safeName);
                payload.put("totalBytes", resolved.contentLength > 0 ? resolved.contentLength : null);
                call.resolve(payload);
            } catch (Exception error) {
                call.reject("Couldn't start the background download: " + error.getMessage());
            }
        });
    }

    /**
     * Poll all tracked background downloads. When the system reports a
     * success, that file is finalized (moved into app-private model storage
     * and recorded) right here, so simply reopening Settings completes the
     * setup. Returns one row per tracked download plus a top-level `active`
     * flag (any still running).
     */
    @PluginMethod
    public void getBackgroundDownloadStatus(PluginCall call) {
        downloadExecutor.execute(() -> {
            java.util.LinkedHashMap<Long, String> tracked = trackedDownloads();
            JSObject payload = new JSObject();
            com.getcapacitor.JSArray downloads = new com.getcapacitor.JSArray();
            if (tracked.isEmpty()) {
                payload.put("active", false);
                payload.put("downloads", downloads);
                call.resolve(payload);
                return;
            }
            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            boolean anyActive = false;
            java.util.LinkedHashMap<Long, String> remaining = new java.util.LinkedHashMap<>(tracked);
            try {
                for (java.util.Map.Entry<Long, String> entry : tracked.entrySet()) {
                    long downloadId = entry.getKey();
                    String fileName = entry.getValue();
                    JSObject row = new JSObject();
                    row.put("downloadId", downloadId);
                    row.put("fileName", fileName);
                    try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
                        if (cursor == null || !cursor.moveToFirst()) {
                            // Cancelled from the notification shade, or cleared.
                            remaining.remove(downloadId);
                            row.put("active", false);
                            downloads.put(row);
                            continue;
                        }
                        int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        long done = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        row.put("bytesDownloaded", done);
                        row.put("totalBytes", total > 0 ? total : null);
                        if (status == DownloadManager.STATUS_SUCCESSFUL) {
                            File source = new File(getContext().getExternalFilesDir(BG_DOWNLOADS_DIR), fileName);
                            try {
                                finalizeDownloadedModel(source, fileName);
                                row.put("active", false);
                                row.put("finalized", true);
                                row.put("modelName", fileName);
                            } catch (Exception error) {
                                row.put("active", false);
                                row.put("error", "Downloaded but couldn't finalize: " + error.getMessage());
                            }
                            remaining.remove(downloadId);
                        } else if (status == DownloadManager.STATUS_FAILED) {
                            int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                            remaining.remove(downloadId);
                            row.put("active", false);
                            row.put("error", describeDownloadFailure(reason));
                        } else {
                            anyActive = true;
                            row.put("active", true);
                            boolean paused = status == DownloadManager.STATUS_PAUSED;
                            row.put("paused", paused);
                            // A stalled download is invisible without the
                            // why — surface the system's reason so the UI
                            // can say "waiting for Wi-Fi" instead of showing
                            // a frozen bar.
                            if (paused || status == DownloadManager.STATUS_PENDING) {
                                int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                                row.put("stateDetail", describeStall(status, reason));
                            }
                        }
                    }
                    downloads.put(row);
                }
                saveTrackedDownloads(remaining);
                payload.put("active", anyActive);
                payload.put("downloads", downloads);
                call.resolve(payload);
            } catch (Exception error) {
                call.reject("Couldn't check the downloads: " + error.getMessage());
            }
        });
    }

    /** Cancel one tracked download (by id) or, with no id, all of them. */
    @PluginMethod
    public void cancelBackgroundDownload(PluginCall call) {
        Double idOption = call.getDouble("downloadId");
        java.util.LinkedHashMap<Long, String> tracked = trackedDownloads();
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (idOption != null) {
            long downloadId = idOption.longValue();
            manager.remove(downloadId);
            tracked.remove(downloadId);
        } else {
            for (Long downloadId : tracked.keySet()) {
                manager.remove(downloadId);
            }
            tracked.clear();
        }
        saveTrackedDownloads(tracked);
        call.resolve();
    }

    /** Why a download is sitting still (PENDING, or PAUSED_* reasons). */
    private String describeStall(int status, int reason) {
        if (status == DownloadManager.STATUS_PENDING) {
            return "Queued — the system hasn't started it yet.";
        }
        switch (reason) {
            case DownloadManager.PAUSED_QUEUED_FOR_WIFI:
                return "Waiting for Wi-Fi — the system queues large downloads off mobile data. "
                    + "Connect to Wi-Fi, or lift the mobile-data download limit in the system Download Manager settings.";
            case DownloadManager.PAUSED_WAITING_FOR_NETWORK:
                return "Waiting for a network connection.";
            case DownloadManager.PAUSED_WAITING_TO_RETRY:
                return "Hit a network error — the system retries automatically with a delay.";
            default:
                return "Paused by the system (reason " + reason + ").";
        }
    }

    /** Human-readable DownloadManager failure reasons. HTTP statuses are
     *  passed through as the reason code; the rest are ERROR_* constants. */
    private String describeDownloadFailure(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_INSUFFICIENT_SPACE:
                return "Not enough storage to finish the download.";
            case DownloadManager.ERROR_CANNOT_RESUME:
                return "The download couldn't resume — tap Download to start it again.";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS:
                return "Too many redirects from the model host.";
            case DownloadManager.ERROR_HTTP_DATA_ERROR:
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE:
                return "Network error during the download — tap Download to try again.";
            case 401:
            case 403:
                return "The download link expired or was refused (HTTP " + reason + "). Tap Download to start "
                    + "again — gated models also need a valid token and an accepted license.";
            default:
                return "Download failed (reason " + reason + "). Tap Download to try again.";
        }
    }

    /** Move a completed download into app-private model storage. It becomes
     *  the current model only when none is set yet — with parallel downloads
     *  "last finished wins" would be arbitrary, and the user switches
     *  explicitly via selectModel anyway. */
    private void finalizeDownloadedModel(File source, String fileName) throws Exception {
        if (!source.exists()) {
            throw new IllegalStateException("downloaded file is missing");
        }
        File dir = new File(getContext().getFilesDir(), MODELS_DIR);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("couldn't create the model directory");
        }
        String current = prefs().getString(PREF_MODEL_NAME, null);
        if (fileName.equals(current)) {
            // Redownloading the current model overwrites the file the engine
            // may have mapped — unload first. Other names never disturb a
            // loaded model.
            closeLlm();
        }
        File target = new File(dir, fileName);
        // External and internal storage may be different volumes; stream-copy.
        try (InputStream in = new java.io.FileInputStream(source);
             OutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[1 << 16];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
        }
        //noinspection ResultOfMethodCallIgnored
        source.delete();
        if (current == null) {
            prefs().edit().putString(PREF_MODEL_NAME, fileName).apply();
        }
    }

    private static final class ResolvedUrl {
        String finalUrl;
        long contentLength = -1;
        String errorMessage;
    }

    /** Follow redirects (auth only to the original host) and return the
     *  final URL + Content-Length without downloading the body. */
    private ResolvedUrl resolveFinalUrl(String url, String authToken) {
        ResolvedUrl result = new ResolvedUrl();
        HttpURLConnection connection = null;
        try {
            String currentUrl = url;
            boolean sendAuth = authToken != null && !authToken.isEmpty();
            for (int hop = 0; hop < 6; hop++) {
                connection = (HttpURLConnection) new URL(currentUrl).openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(30000);
                connection.setRequestMethod("GET");
                connection.setRequestProperty("Range", "bytes=0-0");
                if (sendAuth) {
                    connection.setRequestProperty("Authorization", "Bearer " + authToken);
                }
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    connection.disconnect();
                    if (location == null) {
                        result.errorMessage = "Download redirect had no target.";
                        return result;
                    }
                    currentUrl = location.startsWith("http") ? location : new URL(new URL(currentUrl), location).toString();
                    sendAuth = sendAuth && new URL(currentUrl).getHost().equals(new URL(url).getHost());
                    connection = null;
                    continue;
                }
                if (status == 401 || status == 403) {
                    result.errorMessage = "Download was refused (HTTP " + status + "). Gated models need a valid "
                        + "access token and an accepted license on the hosting site.";
                    return result;
                }
                if (status != 200 && status != 206) {
                    result.errorMessage = "Download failed (HTTP " + status + ").";
                    return result;
                }
                result.finalUrl = currentUrl;
                // Content-Range: bytes 0-0/TOTAL when ranged; else Content-Length.
                String contentRange = connection.getHeaderField("Content-Range");
                if (contentRange != null && contentRange.contains("/")) {
                    try {
                        result.contentLength = Long.parseLong(contentRange.substring(contentRange.lastIndexOf('/') + 1));
                    } catch (NumberFormatException ignored) {
                        result.contentLength = -1;
                    }
                } else {
                    result.contentLength = connection.getContentLengthLong();
                }
                return result;
            }
            result.errorMessage = "Too many redirects.";
            return result;
        } catch (Exception error) {
            result.errorMessage = "Couldn't reach the model host: " + error.getMessage();
            return result;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void doDownload(PluginCall call, String url, String fileName, String authToken) {
        File dir = new File(getContext().getFilesDir(), MODELS_DIR);
        if (!dir.exists() && !dir.mkdirs()) {
            call.reject("Couldn't create the model directory.");
            return;
        }
        File tmp = new File(dir, fileName + ".part");
        HttpURLConnection connection = null;
        try {
            // Manual redirect loop: HttpURLConnection won't follow cross-host
            // redirects reliably, and HF's CDN redirect must not receive the
            // Authorization header meant for huggingface.co.
            String currentUrl = url;
            boolean sendAuth = authToken != null && !authToken.isEmpty();
            for (int hop = 0; hop < 6; hop++) {
                connection = (HttpURLConnection) new URL(currentUrl).openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(60000);
                if (sendAuth) {
                    connection.setRequestProperty("Authorization", "Bearer " + authToken);
                }
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    connection.disconnect();
                    if (location == null) {
                        call.reject("Download redirect had no target.");
                        return;
                    }
                    currentUrl = location.startsWith("http") ? location : new URL(new URL(currentUrl), location).toString();
                    // Auth stays only for the original host.
                    sendAuth = sendAuth && new URL(currentUrl).getHost().equals(new URL(url).getHost());
                    connection = null;
                    continue;
                }
                if (status == 401 || status == 403) {
                    call.reject("Download was refused (HTTP " + status + "). Gated models need a valid access token "
                        + "and an accepted license on the hosting site.");
                    return;
                }
                if (status != 200 && status != 206) {
                    call.reject("Download failed (HTTP " + status + ").");
                    return;
                }
                break;
            }
            if (connection == null) {
                call.reject("Too many redirects.");
                return;
            }

            long totalBytes = connection.getContentLengthLong();
            long free = getContext().getFilesDir().getUsableSpace();
            // Keep a 200 MB cushion so the model can't wedge the device.
            long cushion = 200L * 1024 * 1024;
            if (totalBytes > 0 && totalBytes + cushion > free) {
                call.reject("Not enough storage: model needs " + (totalBytes / (1024 * 1024)) + " MB plus headroom, "
                    + (free / (1024 * 1024)) + " MB free.");
                return;
            }

            long downloaded = 0;
            long lastNotified = 0;
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                byte[] buffer = new byte[1 << 16];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if (downloadCancelled.get()) {
                        //noinspection ResultOfMethodCallIgnored
                        tmp.delete();
                        call.reject("Download cancelled.");
                        return;
                    }
                    out.write(buffer, 0, read);
                    downloaded += read;
                    if (downloaded - lastNotified > (4L << 20)) { // every ~4 MB
                        lastNotified = downloaded;
                        JSObject progress = new JSObject();
                        progress.put("bytesDownloaded", downloaded);
                        progress.put("totalBytes", totalBytes > 0 ? totalBytes : null);
                        notifyListeners("downloadProgress", progress);
                    }
                }
            }

            // Multiple models can coexist; the download becomes current.
            closeLlm();
            File target = new File(dir, fileName);
            if (!tmp.renameTo(target)) {
                call.reject("Couldn't finalize the downloaded model file.");
                return;
            }
            prefs().edit().putString(PREF_MODEL_NAME, fileName).apply();
            JSObject payload = new JSObject();
            payload.put("modelPath", target.getAbsolutePath());
            payload.put("modelName", fileName);
            payload.put("sizeBytes", target.length());
            call.resolve(payload);
        } catch (Exception error) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            call.reject("Model download failed: " + error.getMessage());
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    @PluginMethod
    public void importModel(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "importModelResult");
    }

    @ActivityCallback
    private void importModelResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null
            || result.getData().getData() == null) {
            call.reject("No model file was selected.");
            return;
        }
        Uri uri = result.getData().getData();
        executor.execute(() -> {
            try {
                String name = displayNameOf(uri);
                File dir = new File(getContext().getFilesDir(), MODELS_DIR);
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("Couldn't create the model directory.");
                    return;
                }
                // Multiple models can coexist; the imported one becomes current.
                closeLlm();
                File target = new File(dir, name);
                try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                     OutputStream out = new FileOutputStream(target)) {
                    if (in == null) {
                        call.reject("Couldn't open the selected file.");
                        return;
                    }
                    byte[] buffer = new byte[1 << 16];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                    }
                }
                prefs().edit().putString(PREF_MODEL_NAME, name).apply();
                JSObject payload = new JSObject();
                payload.put("modelPath", target.getAbsolutePath());
                payload.put("modelName", name);
                call.resolve(payload);
            } catch (Exception error) {
                call.reject("Model import failed: " + error.getMessage(), error);
            }
        });
    }

    private String displayNameOf(Uri uri) {
        String name = "model.task";
        try (Cursor cursor = getContext().getContentResolver()
            .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String candidate = cursor.getString(0);
                if (candidate != null && !candidate.isEmpty()) {
                    // Keep only a safe basename — SAF display names are
                    // user-controlled.
                    name = candidate.replaceAll("[^A-Za-z0-9._-]", "_");
                }
            }
        } catch (Exception ignored) {
            // Fall back to the generic name.
        }
        return name;
    }

    @PluginMethod
    public void loadModel(PluginCall call) {
        int maxTokens = call.getInt("maxTokens", DEFAULT_MAX_TOKENS);
        executor.execute(() -> {
            try {
                File model = modelFile();
                if (model == null) {
                    call.reject("No model has been imported yet.");
                    return;
                }
                closeLlm();
                LlmInference.LlmInferenceOptions options = LlmInference.LlmInferenceOptions.builder()
                    .setModelPath(model.getAbsolutePath())
                    .setMaxTokens(maxTokens)
                    .build();
                llm = LlmInference.createFromOptions(getContext(), options);
                JSObject payload = new JSObject();
                payload.put("loaded", true);
                call.resolve(payload);
            } catch (Throwable error) {
                closeLlm();
                call.reject("Couldn't load the model: " + error.getMessage());
            }
        });
    }

    @PluginMethod
    public void generate(PluginCall call) {
        String prompt = call.getString("prompt", "");
        if (prompt == null || prompt.isEmpty()) {
            call.reject("Prompt is required.");
            return;
        }
        executor.execute(() -> {
            try {
                if (llm == null) {
                    call.reject("Model is not loaded.");
                    return;
                }
                String text = llm.generateResponse(prompt);
                JSObject payload = new JSObject();
                payload.put("text", text != null ? text : "");
                call.resolve(payload);
            } catch (Throwable error) {
                call.reject("Generation failed: " + error.getMessage());
            }
        });
    }

    @PluginMethod
    public void unload(PluginCall call) {
        executor.execute(() -> {
            closeLlm();
            call.resolve();
        });
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        String modelName = call.getString("modelName", null);
        executor.execute(() -> {
            File dir = new File(getContext().getFilesDir(), MODELS_DIR);
            String current = prefs().getString(PREF_MODEL_NAME, null);
            String targetName = modelName != null && !modelName.isEmpty() ? modelName : current;
            if (targetName == null) {
                call.resolve();
                return;
            }
            if (targetName.equals(current)) {
                closeLlm();
            }
            File file = new File(dir, targetName);
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            if (targetName.equals(current)) {
                // Point at any remaining model so the UI stays usable.
                File[] remaining = dir.listFiles();
                if (remaining != null && remaining.length > 0) {
                    prefs().edit().putString(PREF_MODEL_NAME, remaining[0].getName()).apply();
                } else {
                    prefs().edit().remove(PREF_MODEL_NAME).apply();
                }
            }
            call.resolve();
        });
    }

    private void closeLlm() {
        if (llm != null) {
            try {
                llm.close();
            } catch (Exception ignored) {
                // Already closed.
            }
            llm = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        downloadCancelled.set(true);
        downloadExecutor.shutdown();
        executor.execute(this::closeLlm);
        executor.shutdown();
        super.handleOnDestroy();
    }
}
