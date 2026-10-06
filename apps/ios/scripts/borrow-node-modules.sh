#!/usr/bin/env bash
# Lets a checkout without node_modules (an orchestrated worker's copy) run the
# generators, check.sh and the host build with another checkout's
# node_modules, read-only, from the same lockfile:
#
#   eval "$(apps/ios/scripts/borrow-node-modules.sh /path/to/checkout-with-node_modules)"
#   apps/ios/scripts/check.sh
#   node apps/ios/scripts/build-host.mjs     # then MC_INTEROP=1 apps/ios/scripts/check.sh
#
# It writes, under $TMPDIR/monocode-borrowed-modules:
#   nm/@monocode/{channel,core,design}  links to this checkout's packages, so
#                                       the workspace packages are this
#                                       checkout's, not the other's;
#   resolve-hook.mjs, register.mjs      an ESM resolve hook: a bare import
#                                       this checkout cannot resolve is
#                                       resolved from the other node_modules
#                                       (Node's ESM loader ignores NODE_PATH);
# and prints the NODE_PATH and NODE_OPTIONS exports. esbuild-based scripts
# (gen-fixtures, gen-channel-fixtures, build-native-assets, build-host) read
# NODE_PATH themselves. Nothing is written to either checkout.
set -euo pipefail

other="${1:?usage: borrow-node-modules.sh <checkout-with-node_modules>}"
modules="$(cd "$other" && pwd)/node_modules"
[ -d "$modules/esbuild" ] || { echo "$modules has no esbuild: run npm ci there" >&2; exit 1; }
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
dir="${TMPDIR:-/tmp}"
dir="${dir%/}/monocode-borrowed-modules"
mkdir -p "$dir/nm/@monocode"
for package in channel core design; do
  ln -sfn "$repo/packages/$package" "$dir/nm/@monocode/$package"
done
cat > "$dir/resolve-hook.mjs" <<HOOK
import { pathToFileURL } from "node:url";
const fallback = pathToFileURL("$modules/").href + "resolve-from.mjs";
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const bare = !/^(\.|\/|file:|node:|data:)/.test(specifier);
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !bare) throw error;
    return next(specifier, { ...context, parentURL: fallback });
  }
}
HOOK
cat > "$dir/register.mjs" <<'REGISTER'
import { register } from "node:module";
register("./resolve-hook.mjs", import.meta.url);
REGISTER
echo "export NODE_PATH='$dir/nm:$modules'"
echo "export NODE_OPTIONS='--import=$dir/register.mjs'"
