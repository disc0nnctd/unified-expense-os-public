#!/usr/bin/env bash
# Build the Android app from the unified web codebase.
#
# The app is the React PWA in web/ wrapped by Capacitor — there is no separate
# Android UI codebase. This script builds the web bundle, syncs it into the
# native shell, and assembles an APK.
#
# Requirements: JDK 21 and an Android SDK (platform-tools, platforms;android-35,
# build-tools;35.0.0). Point JAVA_HOME / ANDROID_HOME at them, or let the
# defaults below use the userspace toolchain under ~/.local/android-build that
# the initial setup installed.
set -euo pipefail

JAVA_HOME="${JAVA_HOME:-$HOME/.local/android-build/jdk21}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/.local/android-build/sdk}"
export JAVA_HOME ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$PATH"

# debug (default) | release
VARIANT="${1:-debug}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/web"

echo "==> java: $(java -version 2>&1 | head -1)"
echo "==> building web bundle"
npm run build

echo "==> syncing Capacitor Android"
npx cap sync android

cd android
if [ "$VARIANT" = "release" ]; then
  echo "==> assembling release (unsigned)"
  ./gradlew assembleRelease --no-daemon
  echo "APK: web/android/app/build/outputs/apk/release/app-release-unsigned.apk"
else
  echo "==> assembling debug"
  ./gradlew assembleDebug --no-daemon
  echo "APK: web/android/app/build/outputs/apk/debug/app-debug.apk"
  # Publish the APK through the web app (Settings → Android app). Git-ignored;
  # rebuild the web container afterwards so the served copy updates.
  cp app/build/outputs/apk/debug/app-debug.apk "$ROOT/web/public/expense-os.apk"
  echo "Copied to web/public/expense-os.apk (redeploy web to serve it)"
fi
