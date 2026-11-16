#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/swift"

UNIVERSAL=0
if [[ "${1:-}" == "--universal" ]]; then
  UNIVERSAL=1
fi

# Build arm64 (native)
swift build -c release
BIN="$(swift build -c release --show-bin-path)/apple-fm-bridge"

mkdir -p "$ROOT/bin"

if [[ "$UNIVERSAL" -eq 1 ]]; then
  # Try to build universal via lipo when possible.
  # On Apple Silicon, build x86_64 under Rosetta if available, then lipo.
  echo "Attempting universal build (--universal) ..."
  if command -v lipo >/dev/null 2>&1; then
    # Build x86_64 slice (requires Rosetta SDK; fallback to arm64-only on failure)
    if (cd "$ROOT/swift" && arch -x86_64 swift build -c release 2>/dev/null); then
      BIN_X64="$(arch -x86_64 swift build -c release --show-bin-path)/apple-fm-bridge"
      BIN_ARM64="$BIN"
      if [[ -f "$BIN_X64" && -f "$BIN_ARM64" ]]; then
        lipo -create "$BIN_ARM64" "$BIN_X64" -output "$ROOT/bin/apple-fm-bridge"
        echo "Built universal bin/apple-fm-bridge (arm64 + x86_64)"
      else
        cp "$BIN" "$ROOT/bin/apple-fm-bridge"
        echo "Built arm64-only (x86_64 slice missing) — use prebuilt fallback"
      fi
    else
      echo "x86_64 build unavailable (Rosetta/SDK missing) — building arm64 universal fallback"
      cp "$BIN" "$ROOT/bin/apple-fm-bridge"
      echo "Built arm64-only bin/apple-fm-bridge"
    fi
  else
    cp "$BIN" "$ROOT/bin/apple-fm-bridge"
    echo "lipo not found — built arm64-only"
  fi
else
  cp "$BIN" "$ROOT/bin/apple-fm-bridge"
  echo "Built $ROOT/bin/apple-fm-bridge (arm64)"
fi

chmod +x "$ROOT/bin/apple-fm-bridge"

# Verify arch
if command -v file >/dev/null 2>&1; then file "$ROOT/bin/apple-fm-bridge" || true; fi
if command -v lipo >/dev/null 2>&1; then lipo -info "$ROOT/bin/apple-fm-bridge" 2>/dev/null || true; fi

if [[ -n "${APPLE_FM_SIGN_IDENTITY:-}" ]]; then
  codesign --force --sign "$APPLE_FM_SIGN_IDENTITY" --options runtime --timestamp "$ROOT/bin/apple-fm-bridge"
  echo "Signed bin/apple-fm-bridge with $APPLE_FM_SIGN_IDENTITY"
  if command -v notarytool >/dev/null 2>&1 && [[ -n "${APPLE_NOTARY_PROFILE:-}" ]]; then
    echo "Notarizing (notarytool profile: $APPLE_NOTARY_PROFILE) ..."
    # Notarizing requires a zip; keep step explicit for CI
    NOTARY_ZIP="$ROOT/bin/apple-fm-bridge.zip"
    ditto -c -k --sequesterRsrc --keepParent "$ROOT/bin/apple-fm-bridge" "$NOTARY_ZIP" || true
    xcrun notarytool submit "$NOTARY_ZIP" --wait --profile "$APPLE_NOTARY_PROFILE" || echo "Notarization submitted (check Apple portal if staple needed)"
    xcrun stapler staple "$ROOT/bin/apple-fm-bridge" || true
    rm -f "$NOTARY_ZIP"
  fi
else
  echo "Unsigned binary. Set APPLE_FM_SIGN_IDENTITY and notarize for distribution outside npm-local use."
fi

echo "Built $ROOT/bin/apple-fm-bridge"
