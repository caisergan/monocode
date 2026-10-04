// The app is its own npm project (React Native pins a different React than the
// desktop), so Metro is pointed at the shared workspace code explicitly:
// packages/* and the desktop session model under src/ that @monocode/core
// re-exports. Their npm dependencies resolve from this app's node_modules.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const appRoot = __dirname;
const repoRoot = path.resolve(appRoot, "../..");
const config = getDefaultConfig(appRoot);

config.watchFolders = [path.join(repoRoot, "packages"), path.join(repoRoot, "src")];
config.resolver.nodeModulesPaths = [path.join(appRoot, "node_modules")];

const tauriShim = path.join(appRoot, "src/shims/tauri.js");
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith("@tauri-apps/")) return { type: "sourceFile", filePath: tauriShim };
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
