// Spike S1 (14): does Hermes accept every regex the highlighter can build?
// Only the Hermes compiler is installed, not the VM, so this collects the
// regexes and compiles them as literals with hermesc, which validates each
// pattern and its flags the way the VM's RegExp constructor does:
//
//   1. every pattern in the bundled Shiki grammars, converted by Shiki's
//      JavaScript engine with the app's target (shiki.ts REGEX_TARGET);
//   2. the regexes built through the global RegExp while Shiki and
//      highlight.js highlight a sample in every language;
//   3. every regex literal in the modules Metro bundles for src/highlight,
//      found by resolving its import graph with metro-resolver and this app's
//      metro.config.js for iOS and Android (which also checks that every
//      import resolves under package exports).
//
// Run from apps/mobile (VERBOSE=1 lists the bundled modules):
//   ../../node_modules/.bin/vite-node src/highlight/scripts/hermes-regex-check.ts

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import type { CustomResolver, ResolutionContext } from "metro-resolver";
import { defaultJavaScriptRegexConstructor } from "shiki/engine/javascript";
import { SAMPLES } from "../__tests__/samples";
import { createHljsBackend } from "../hljs";
import { LANGUAGES } from "../languages";
import { GRAMMARS, REGEX_TARGET, startShiki } from "../shiki";

type Entry = { source: string; flags: string; origin: string };

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(appRoot, "package.json"));
const hermesc = join(
  appRoot,
  "node_modules/hermes-compiler/hermesc",
  { darwin: "osx-bin", linux: "linux64-bin", win32: "win64-bin" }[process.platform as string] ?? "osx-bin",
  process.platform === "win32" ? "hermesc.exe" : "hermesc",
);
const work = join(tmpdir(), "monocode-hermes-regex-check");

/** Compiles `code` with hermesc; returns its error lines. */
function compile(name: string, code: string): string[] {
  const file = `${work}-${name}.js`;
  writeFileSync(file, code);
  try {
    execFileSync(hermesc, ["-emit-binary", "-out", `${file}.hbc`, file], { stdio: "pipe" });
    return [];
  } catch (error) {
    const output = String((error as { stderr?: Buffer }).stderr ?? error);
    return output.split("\n").filter((line) => line.includes("error:"));
  }
}

const literal = (entry: Pick<Entry, "source" | "flags">) => String(new RegExp(entry.source, entry.flags));

// 0. hermesc must reject what Hermes can't run, or a clean result means nothing.
const canary = compile("canary", "var a = /a/v;\nvar b = /\\p{Nope}/u;\nvar c = /(?i:a)/;\nvar d = /a/dgiuy;\n");
if (canary.length !== 3 || canary.some((line) => line.includes(":4:")))
  throw new Error(`hermesc didn't behave as expected on the canary:\n${canary.join("\n")}`);

// 1. Grammar patterns, converted exactly as the engine converts them.
const grammarPatterns = new Map<string, string>();
const collect = (node: unknown, grammar: string): void => {
  if (Array.isArray(node)) for (const item of node) collect(item, grammar);
  else if (node && typeof node === "object")
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && ["match", "begin", "end", "while"].includes(key)) {
        if (!grammarPatterns.has(value)) grammarPatterns.set(value, grammar);
      } else collect(value, grammar);
    }
};
for (const id of LANGUAGES) for (const grammar of (await GRAMMARS[id]()).default) collect(grammar, grammar.name);
const entries: Entry[] = [];
const conversionFailures: string[] = [];
for (const [pattern, grammar] of grammarPatterns) {
  try {
    const regex = defaultJavaScriptRegexConstructor(pattern, { target: REGEX_TARGET });
    entries.push({ source: regex.source, flags: regex.flags, origin: `shiki ${grammar}` });
  } catch (error) {
    conversionFailures.push(`${grammar}: ${(error as Error).message} in ${pattern.slice(0, 120)}`);
  }
}
const grammarCount = entries.length;

// 2. Regexes built at runtime while both backends highlight every sample.
const NativeRegExp = RegExp;
let runtimeCount = 0;
const record = (regex: RegExp, origin: string) => {
  runtimeCount++;
  entries.push({ source: regex.source, flags: regex.flags, origin });
};
for (const backend of ["shiki", "highlight.js"] as const) {
  globalThis.RegExp = new Proxy(NativeRegExp, {
    construct(target, args, newTarget) {
      const regex = Reflect.construct(target, args, newTarget) as RegExp;
      record(regex, `${backend} runtime`);
      return regex;
    },
    apply(target, self, args) {
      const regex = Reflect.apply(target, self, args) as RegExp;
      record(regex, `${backend} runtime`);
      return regex;
    },
  });
  try {
    if (backend === "shiki") {
      const shiki = await startShiki();
      for (const id of LANGUAGES) await shiki.tokenize(SAMPLES[id], id, "dark");
    } else {
      const hljs = createHljsBackend();
      for (const id of LANGUAGES) if (!hljs.tokenize(SAMPLES[id], id, "dark")) throw new Error(`highlight.js failed on ${id}`);
    }
  } finally {
    globalThis.RegExp = NativeRegExp;
  }
}

// 3. The module graph Metro bundles for src/highlight, and its regex literals.
const metroResolve = (require("metro-resolver") as typeof import("metro-resolver")).resolve;
const createDefaultContext = require("metro-resolver/private/createDefaultContext").default as (
  context: Omit<ResolutionContext, "redirectModulePath">,
) => ResolutionContext;
const resolverConfig = (require(join(appRoot, "metro.config.js")) as { resolver: Record<string, unknown> }).resolver;
const packageJson = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const baseContext = {
  allowHaste: false,
  assetExts: new Set(resolverConfig.assetExts as string[]),
  customResolverOptions: {},
  dev: false,
  disableHierarchicalLookup: resolverConfig.disableHierarchicalLookup as boolean,
  doesFileExist: (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
  extraNodeModules: resolverConfig.extraNodeModules as Record<string, string>,
  fileSystemLookup: (path: string) => {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat ? { exists: true as const, type: stat.isDirectory() ? ("d" as const) : ("f" as const), realPath: realpathSync(path) } : { exists: false as const };
  },
  getPackage: packageJson,
  getPackageForModule: (path: string) => {
    for (let dir = dirname(path); dir !== dirname(dir) && !dir.endsWith(`${sep}node_modules`); dir = dirname(dir)) {
      const json = packageJson(join(dir, "package.json"));
      if (json) return { packageJson: json, rootPath: dir, packageRelativePath: path.slice(dir.length + 1) };
    }
    return null;
  },
  mainFields: resolverConfig.resolverMainFields as string[],
  nodeModulesPaths: resolverConfig.nodeModulesPaths as string[],
  preferNativePlatform: true,
  resolveAsset: () => null,
  resolveHasteModule: () => undefined,
  resolveHastePackage: () => undefined,
  resolveRequest: resolverConfig.resolveRequest as CustomResolver,
  sourceExts: resolverConfig.sourceExts as string[],
  unstable_conditionNames: resolverConfig.unstable_conditionNames as string[],
  unstable_conditionsByPlatform: resolverConfig.unstable_conditionsByPlatform as Record<string, string[]>,
  unstable_enablePackageExports: resolverConfig.unstable_enablePackageExports as boolean,
  unstable_incrementalResolution: false,
  unstable_logWarning: (message: string) => console.warn(`[metro] ${message}`),
};

type Node = { type?: string; [key: string]: unknown };
const walk = (node: unknown, visit: (node: Node) => void): void => {
  if (Array.isArray(node)) for (const item of node) walk(item, visit);
  else if (node && typeof node === "object" && typeof (node as Node).type === "string") {
    visit(node as Node);
    for (const value of Object.values(node)) walk(value, visit);
  }
};
const stringArg = (node: Node | undefined) => (node?.type === "StringLiteral" ? (node.value as string) : undefined);

const modules = new Map<string, number>();
const unresolved: string[] = [];
for (const platform of ["ios", "android"]) {
  const pending = [join(appRoot, "src/highlight/index.ts")];
  const seen = new Set(pending);
  while (pending.length) {
    const file = pending.pop()!;
    if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extname(file))) continue;
    const ast = parse(readFileSync(file, "utf8"), {
      sourceType: "unambiguous",
      plugins: [...(/\.tsx?$/.test(file) ? (["typescript"] as const) : []), "jsx"],
    });
    const dependencies: { name: string; isESMImport: boolean }[] = [];
    let literals = 0;
    walk(ast.program, (node) => {
      if (node.type === "RegExpLiteral") {
        literals++;
        entries.push({ source: node.pattern as string, flags: node.flags as string, origin: file.slice(appRoot.length + 1) });
      } else if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") {
        const name = stringArg(node.source as Node);
        if (name && node.importKind !== "type" && node.exportKind !== "type") dependencies.push({ name, isESMImport: true });
      } else if (node.type === "CallExpression") {
        const callee = node.callee as Node;
        const name = stringArg((node.arguments as Node[])[0]);
        if (name && callee.type === "Import") dependencies.push({ name, isESMImport: true });
        if (name && callee.type === "Identifier" && callee.name === "require") dependencies.push({ name, isESMImport: false });
      }
    });
    modules.set(file, literals);
    for (const { name, isESMImport } of dependencies) {
      try {
        const resolution = metroResolve(createDefaultContext({ ...baseContext, originModulePath: file, isESMImport }), name, platform);
        if (resolution.type !== "sourceFile") continue;
        if (!seen.has(resolution.filePath)) {
          seen.add(resolution.filePath);
          pending.push(resolution.filePath);
        }
      } catch (error) {
        unresolved.push(`${platform}: ${name} from ${file.slice(appRoot.length + 1)}: ${(error as Error).message.split("\n")[0]}`);
      }
    }
  }
}
const literalCount = [...modules.values()].reduce((sum, count) => sum + count, 0);

// Compile everything as one file, one literal per line.
const unique = [...new Map(entries.map((entry) => [`${entry.flags}/${entry.source}`, entry])).values()];
const errors = compile(
  "regexes",
  `var regexes = [\n${unique.map((entry) => `${literal(entry)}, // ${entry.origin.replace(/[\r\n]/g, " ")}`).join("\n")}\n];\n`,
);
const flags = new Map<string, number>();
for (const entry of unique) flags.set(entry.flags, (flags.get(entry.flags) ?? 0) + 1);

console.log(`hermesc: ${hermesc}`);
console.log("Canary: hermesc rejects the v flag, unknown properties and modifiers, and accepts dgiuy.");
console.log(`Shiki grammars (${LANGUAGES.length} languages, target ${REGEX_TARGET}): ${grammarPatterns.size} patterns, ${grammarCount} converted, ${conversionFailures.length} failed`);
console.log(`Runtime RegExp constructions while highlighting the samples: ${runtimeCount}`);
console.log(`Metro graph (ios + android): ${modules.size} modules, ${literalCount} regex literals, ${unresolved.length} unresolved imports`);
console.log(`Unique regexes compiled: ${unique.length} (flags: ${[...flags].map(([key, count]) => `${key || "none"} ${count}`).join(", ")})`);
if (process.env.VERBOSE) for (const [file, count] of modules) console.log(`  ${file.slice(appRoot.length + 1)}: ${count}`);
for (const line of [...conversionFailures, ...unresolved, ...errors]) console.log(`  ${line}`);
if (conversionFailures.length || unresolved.length || errors.length) {
  console.log(`FAILED: ${errors.length} hermesc errors (see ${work}-regexes.js)`);
  process.exitCode = 1;
} else console.log("OK: hermesc accepts every regex.");
