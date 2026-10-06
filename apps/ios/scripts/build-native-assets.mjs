#!/usr/bin/env node
// The desktop's file-type icons → MonoTranscript (11 §11.7). It reads the
// same `react-material-icon-theme` package the desktop's FileTypeIcon uses
// and writes:
//
//   Resources/FileIcons.xcassets   every icon a file name or extension maps
//                                  to, as a vector image set
//   Resources/file-icons.json      the name and extension tables
//   Tests/…/file-icon-samples.json the desktop's `resolveFileIcon` for sample
//                                  names, for the parity test
//
// `--check` fails when anything on disk is stale instead of writing it.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const transcript = join(here, "../Packages/MonoTranscript");
const catalog = join(transcript, "Sources/MonoTranscript/Resources/FileIcons.xcassets");
const tablePath = join(transcript, "Sources/MonoTranscript/Resources/file-icons.json");
const samplesPath = join(transcript, "Tests/MonoTranscriptTests/Fixtures/file-icon-samples.json");

// The repo's node_modules, then NODE_PATH's, as Node resolves a bare name.
const modules = [join(repo, "node_modules"), ...(process.env.NODE_PATH?.split(delimiter).filter(Boolean) ?? [])];
const iconTheme = modules.map((dir) => join(dir, "react-material-icon-theme/dist/index.esm.js")).find(existsSync);
if (!iconTheme) throw new Error("react-material-icon-theme is not installed: run npm ci at the repo root");
const icons = await import(pathToFileURL(iconTheme).href);

/** The desktop's resolveFileIcon (src/features/files/ui/FileTypeIcon.tsx). */
function resolveFileIcon(fileName) {
  const key = fileName.toLowerCase();
  const fromName = icons.getFileIcon({ fileName: key, fallback: "", iconPack: "" });
  if (fromName) return fromName;
  const parts = key.split(".");
  const start = parts[0] === "" ? 1 : 0;
  for (let i = start + 1; i < parts.length; i++) {
    const fromExt = icons.getFileIcon({ fileExtension: parts.slice(i).join("."), fallback: "", iconPack: "" });
    if (fromExt) return fromExt;
  }
  return "file";
}

const fileNames = {};
const fileExtensions = {};
for (const name of icons.getAvailableFileNames()) {
  const icon = icons.getFileIcon({ fileName: name.toLowerCase(), fallback: "", iconPack: "" });
  if (icon) fileNames[name.toLowerCase()] = icon;
}
for (const ext of icons.getAvailableFileExtensions()) {
  const icon = icons.getFileIcon({ fileExtension: ext, fallback: "", iconPack: "" });
  if (icon) fileExtensions[ext.toLowerCase()] = icon;
}
const used = new Set(["file", ...Object.values(fileNames), ...Object.values(fileExtensions)]);

const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const outputs = new Map();
outputs.set(tablePath, JSON.stringify({ fileNames: sorted(fileNames), fileExtensions: sorted(fileExtensions) }) + "\n");

const SAMPLES = [
  "rows.ts", "markdown.ts", "App.tsx", "index.d.ts", "Package.swift", "main.rs", "Cargo.toml", "README.md", "readme.md",
  "Makefile", "Dockerfile", "package.json", "tsconfig.json", "vitest.config.ts", "vite.config.mjs", ".gitignore",
  ".env.local", "style.module.css", "logo.png", "notes.txt", "LICENSE", "script.sh", "data.yaml", "noext", "archive.tar.gz",
  "component.test.tsx", "schema.prisma", "go.mod", "build.gradle.kts", "AUTH_TEST.TS", ".eslintrc.cjs", "x.unknownext",
];
outputs.set(samplesPath, JSON.stringify(Object.fromEntries(SAMPLES.map((name) => [name, resolveFileIcon(name)]))) + "\n");

const imageSet = (name) =>
  JSON.stringify(
    {
      images: [{ filename: `${name}.svg`, idiom: "universal" }],
      info: { author: "xcode", version: 1 },
      properties: { "preserves-vector-representation": true, "template-rendering-intent": "original" },
    },
    null,
    2,
  ) + "\n";
outputs.set(join(catalog, "Contents.json"), JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2) + "\n");
// A few mappings name an icon the package ships no SVG for; the desktop
// draws an empty slot for them, and so does the phone.
for (const name of [...used]) if (!icons.getIconSvg(name)) used.delete(name);
for (const name of [...used].sort()) {
  const svg = icons.getIconSvg(name);
  outputs.set(join(catalog, `${name}.imageset`, `${name}.svg`), svg + "\n");
  outputs.set(join(catalog, `${name}.imageset`, "Contents.json"), imageSet(name));
}

const check = process.argv.includes("--check");
let stale = false;
// Image sets for icons the package no longer maps to.
const existing = await readdir(catalog).catch(() => []);
for (const entry of existing.filter((entry) => entry.endsWith(".imageset"))) {
  if (used.has(entry.slice(0, -".imageset".length))) continue;
  if (check) {
    console.error(`${entry} is no longer used; run node apps/ios/scripts/build-native-assets.mjs`);
    stale = true;
  } else {
    await rm(join(catalog, entry), { recursive: true });
  }
}
let written = 0;
for (const [path, text] of outputs) {
  const previous = await readFile(path, "utf8").catch(() => "");
  if (previous === text) continue;
  if (check) {
    console.error(`${path.slice(transcript.length + 1)} is out of date; run node apps/ios/scripts/build-native-assets.mjs`);
    stale = true;
    break;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  written++;
}
if (stale) process.exit(1);
if (!check) console.log(`${used.size} icons, ${Object.keys(fileNames).length} names, ${Object.keys(fileExtensions).length} extensions; wrote ${written} files`);
