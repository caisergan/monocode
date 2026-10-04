// Code in every bundled language, for the tests and the scripts (the Hermes
// regex check highlights these to collect highlight.js's runtime regexes).

import type { LanguageId } from "../languages";

export const TS = [
  "// Tabs, trailing spaces, empty lines and non-ASCII text survive.",
  'import { readFile } from "node:fs/promises";',
  "",
  "export async function load(path: string): Promise<number> {",
  '\tconst text = await readFile(path, "utf8"); // café ☕ 𝒳',
  '\t\treturn text.split("\\n").length;   ',
  "}",
  "",
].join("\n");

/** A few lines in every bundled language, each with a tab somewhere. */
export const SAMPLES: Record<LanguageId, string> = {
  typescript: TS,
  tsx: "export const App = () => (\n\t<View style={{ flex: 1 }}>{'hi'}</View>\n);",
  javascript: "const re = /a+b/g;\nfunction f(x) {\n\treturn `${x}`;\n}",
  jsx: "const a = <a href=\"#\">\n\t{label}\n</a>;",
  json: '{\n\t"name": "mobile",\n\t"private": true,\n\t"n": [1, 2.5e3, null]\n}',
  markdown: "# Title\n\n- **bold** and _em_ `code`\n\t> quote\n\n```ts\nlet x = 1;\n```",
  css: ".a > .b:hover {\n\tcolor: #fff;\n\tmargin: 0 auto !important;\n}",
  scss: "$c: red;\n.a {\n\t&:hover { color: darken($c, 10%); }\n}",
  html: '<!doctype html>\n<div class="a">&amp;\n\t<script>let x = 1;</script>\n\t<style>p { color: red }</style>\n</div>',
  swift: "struct A: View {\n\tvar body: some View { Text(\"hi \\(name)\") }\n}",
  kotlin: "data class A(val x: Int) {\n\tfun f() = \"$x\"\n}",
  java: "public class A {\n\t@Override public String toString() { return \"a\"; }\n}",
  rust: "fn main() {\n\tlet v: Vec<u8> = vec![1, 2];\n\tprintln!(\"{:?}\", v);\n}",
  python: "@dataclass\nclass A:\n\tdef f(self, x: int) -> str:\n\t\treturn f\"{x!r}\"",
  go: "package main\n\nfunc main() {\n\tfmt.Println(`raw`, 'c')\n}",
  shellscript: "#!/usr/bin/env bash\nif [[ -n \"$1\" ]]; then\n\techo \"${HOME}\" | grep -E 'a|b'\nfi",
  yaml: "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest # comment",
  toml: "[package]\nname = \"a\"\nversion = \"0.1.0\"\n\t[deps]\nserde = { version = \"1\" }",
  sql: "SELECT id, name\nFROM users\nWHERE created_at > NOW() - INTERVAL '1 day';",
  diff: "--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n \tcontext",
};

/** A TypeScript module of `lines` lines: the input spike S1 measures (14). */
export function typescriptModule(lines = 400): string {
  const out = ['import { createHash } from "node:crypto";', 'import type { Session } from "./types";', ""];
  for (let i = 0; out.length < lines; i++) {
    out.push(
      `/** Entry ${i}: keeps the ${i % 2 ? "newest" : "oldest"} revision. */`,
      `export interface Entry${i}<T extends object = Record<string, unknown>> {`,
      `\treadonly id: \`entry-\${string}\`;`,
      "\tvalue: T | null;",
      "}",
      "",
      `export class Store${i} extends Map<string, Entry${i}> {`,
      "\tprivate hits = 0;",
      `\tasync load(session: Session, path = "/tmp/${i}.json"): Promise<number> {`,
      "\t\tconst digest = createHash(\"sha1\").update(path).digest(\"hex\");",
      `\t\tif (!/^[0-9a-f]{40}$/.test(digest) || session.id === undefined) throw new Error(\`bad \${path}\`);`,
      `\t\tfor (const [key, entry] of this) this.hits += entry.value ? key.length * ${i} : -1;`,
      "\t\treturn this.hits >>> 0; // unsigned",
      "\t}",
      "}",
      "",
    );
  }
  return out.slice(0, lines).join("\n");
}
