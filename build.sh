#!/usr/bin/env bash
# Builds MonoCode.app for this Mac.
#
#   ./build.sh                 build for this Mac's architecture
#   ./build.sh --arch x86_64   build for Intel (arm64 | x86_64 | universal)
#   ./build.sh --install       also copy the app into /Applications
#
# The app is ad-hoc signed, like `tauri build` without a release identity, so
# it runs on this machine but is not notarized for distribution. Updater
# artifacts are skipped: they need the release signing key.
set -euo pipefail

cd "$(dirname "$0")"

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
}

arch="$(uname -m)"
install=false
while [ $# -gt 0 ]; do
  case "$1" in
    --arch)
      [ $# -ge 2 ] || { usage >&2; exit 1; }
      arch="$2"
      shift 2
      ;;
    --install) install=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build.sh builds the macOS .app and must run on macOS." >&2
  exit 1
fi

case "$arch" in
  arm64 | aarch64) target="aarch64-apple-darwin" ;;
  x86_64) target="x86_64-apple-darwin" ;;
  universal) target="universal-apple-darwin" ;;
  *) echo "Unsupported --arch: $arch (use arm64, x86_64 or universal)" >&2; exit 1 ;;
esac

for tool in node npm cargo rustup; do
  command -v "$tool" >/dev/null || { echo "Missing $tool on PATH." >&2; exit 1; }
done

# Rust targets the build needs; universal needs both.
if [ "$target" = "universal-apple-darwin" ]; then
  rust_targets=(aarch64-apple-darwin x86_64-apple-darwin)
else
  rust_targets=("$target")
fi
installed_targets="$(rustup target list --installed)"
for rust_target in "${rust_targets[@]}"; do
  if ! grep -qx "$rust_target" <<<"$installed_targets"; then
    echo "==> Adding Rust target $rust_target"
    rustup target add "$rust_target"
  fi
done

# Reinstall only when the lockfile changed since the last install.
if [ ! -f node_modules/.package-lock.json ] ||
  [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "==> Installing npm dependencies"
  npm ci
fi

echo "==> Building MonoCode.app ($target)"
# `beforeBuildCommand` runs `npm run build` (tsc + vite) first.
npx tauri build \
  --target "$target" \
  --bundles app \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'

app="target/$target/release/bundle/macos/MonoCode.app"
if [ ! -d "$app" ]; then
  echo "Build finished but $app was not found." >&2
  exit 1
fi

if $install; then
  echo "==> Installing to /Applications"
  rm -rf /Applications/MonoCode.app
  ditto "$app" /Applications/MonoCode.app
  app="/Applications/MonoCode.app"
fi

echo
echo "Built $(cd "$(dirname "$app")" && pwd)/$(basename "$app")"
