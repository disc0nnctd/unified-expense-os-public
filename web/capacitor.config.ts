import type { CapacitorConfig } from "@capacitor/cli";

// Unified native shell config. The same Vite `dist/` bundle that ships as the
// web PWA is packaged verbatim into the Android (and later iOS) app — there is
// no platform-specific UI codebase. See docs/native-packaging.md.
const config: CapacitorConfig = {
  appId: "com.unifiedexpenseos.app",
  appName: "Unified Expense OS",
  // Vite build output; `cap sync` copies this into each native platform.
  webDir: "dist",
  android: {
    // The self-hosted backend is commonly reached over plain HTTP on a LAN /
    // tailnet address. Allow cleartext so a user can point the app at
    // http://<host>:8000 without forcing TLS. Traffic is still restricted to
    // the user-configured origin at the app layer (see runtime server URL).
    allowMixedContent: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: false,
      backgroundColor: "#14161a",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
    },
  },
};

export default config;
