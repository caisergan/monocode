#!/usr/bin/env bash
# The phone app's checks (12 §12.2, 16 §16.7):
#   1. the generated tokens and fixtures match their TypeScript sources;
#   2. `swift test` for every package that builds for macOS;
#   3. `xcodebuild test` on the simulator for the iOS-only packages, then the app.
#      Parallel testing is off: it would boot throwaway clones of the simulator.
#
# MC_SIMULATOR picks the simulator, as an xcodebuild destination key:
#   MC_SIMULATOR="id=073CABFE-…" scripts/check.sh   (default: name=iPhone 17,OS=27.0)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
destination="platform=iOS Simulator,${MC_SIMULATOR:-name=iPhone 17,OS=27.0}"

step() { printf '\n== %s\n' "$*"; }

step "Generated files are current"
node "$root/scripts/gen-design-tokens.mjs" --check
node "$root/scripts/gen-fixtures.mjs" --check

ios_only=()
for manifest in "$root"/Packages/*/Package.swift; do
  package="$(basename "$(dirname "$manifest")")"
  if grep -q '\.macOS(' "$manifest"; then
    step "swift test: $package"
    (cd "$(dirname "$manifest")" && swift test)
  else
    ios_only+=("$package")
  fi
done

for package in "${ios_only[@]}"; do
  step "xcodebuild test: $package"
  (cd "$root/Packages/$package" &&
    xcodebuild test -quiet -parallel-testing-enabled NO -scheme "$package" -destination "$destination" \
      -derivedDataPath "$root/build/DerivedData-packages")
done

step "xcodebuild test: MonoCode"
xcodebuild test -quiet -parallel-testing-enabled NO -project "$root/MonoCode.xcodeproj" -scheme MonoCode \
  -destination "$destination" -derivedDataPath "$root/build/DerivedData"

step "All checks passed"
