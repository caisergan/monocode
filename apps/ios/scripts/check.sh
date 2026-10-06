#!/usr/bin/env bash
# The phone app's checks (12 §12.2, 16 §16.7):
#   1. the generated tokens and fixtures match their TypeScript sources;
#   2. `swift test` for every package that builds for macOS (the interop test
#      skipped);
#   3. with MC_INTEROP=1, the interop test (16 §16.5): the host bundle built,
#      then `swift test --filter Interop` in MonoSync against a real host in a
#      temporary data directory;
#   4. `xcodebuild test` on the simulator for the iOS-only packages, then the app.
#      Parallel testing is off: it would boot throwaway clones of the simulator.
#
# MC_SIMULATOR picks the simulator, as an xcodebuild destination key:
#   MC_SIMULATOR="id=073CABFE-…" scripts/check.sh   (default: name=iPhone 17,OS=27.0)
# MC_INTEROP=1 adds step 3. The host bundle comes from `npm run host:build`
# when the repo has node_modules; without them, from scripts/build-host.mjs
# when NODE_PATH is set (below), else an existing build/host/monocode-host.mjs
# is used, and its absence fails the step.
#
# A checkout without node_modules (an orchestrated worker's copy) borrows
# another checkout's, read-only, from the same lockfile:
#   eval "$(scripts/borrow-node-modules.sh /path/to/checkout-with-node_modules)"
#   scripts/check.sh && MC_INTEROP=1 scripts/check.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$root/../.." && pwd)"
destination="platform=iOS Simulator,${MC_SIMULATOR:-name=iPhone 17,OS=27.0}"

step() { printf '\n== %s\n' "$*"; }

step "Generated files are current"
node "$root/scripts/gen-design-tokens.mjs" --check
node "$root/scripts/gen-fixtures.mjs" --check
node "$root/scripts/gen-channel-fixtures.mjs" --check
node "$root/scripts/build-native-assets.mjs" --check

ios_only=()
for manifest in "$root"/Packages/*/Package.swift; do
  package="$(basename "$(dirname "$manifest")")"
  if grep -q '\.macOS(' "$manifest"; then
    step "swift test: $package"
    (cd "$(dirname "$manifest")" && swift test --skip Interop)
  else
    ios_only+=("$package")
  fi
done

if [ "${MC_INTEROP:-0}" = "1" ]; then
  step "Host bundle"
  if [ -d "$repo/node_modules" ]; then
    (cd "$repo" && npm run host:build)
  elif [ -n "${NODE_PATH:-}" ]; then
    echo "No node_modules at the repo root: building with NODE_PATH (no type check of host/)."
    node "$root/scripts/build-host.mjs"
  elif [ -f "$repo/build/host/monocode-host.mjs" ]; then
    echo "No node_modules at the repo root: using the existing build/host/monocode-host.mjs."
    echo "Run npm ci, then npm run host:build, to rebuild it."
  else
    echo "build/host/monocode-host.mjs is absent and the repo has no node_modules: run npm ci, then npm run host:build." >&2
    exit 1
  fi
  step "Interop: MonoSync against a real host"
  (cd "$root/Packages/MonoSync" && swift test --filter Interop 2>&1 | tee "${TMPDIR:-/tmp}/monocode-interop.log")
  if grep -q "Interop skipped" "${TMPDIR:-/tmp}/monocode-interop.log"; then
    echo "The interop test skipped." >&2
    exit 1
  fi
fi

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
