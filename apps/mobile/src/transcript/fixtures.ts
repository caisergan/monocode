// Synthetic transcripts for the lab and the benchmark (15 §15.6): every row
// kind, long markdown, large code blocks. Generated, not exported from real
// sessions, so no private work ends up in the repository.

import type { Block } from "@monocode/core/session";

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const WORDS =
  "the session host phone channel row layout measure stream token approval delta window anchor render native thread budget frame scroll fold trail commit branch worktree provider model reply question plan build test file module package cache sync revision event watch".split(
    " ",
  );
const FILES = ["src/auth/session.ts", "host/engine.ts", "packages/channel/src/noise.ts", "apps/mobile/src/app/index.tsx", "README.md", "src-tauri/src/remote.rs", "vitest.config.ts"];

function sentence(next: () => number, words = 8 + Math.floor(next() * 14)): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    let word = WORDS[Math.floor(next() * WORDS.length)];
    if (next() < 0.06) word = `\`${FILES[Math.floor(next() * FILES.length)]}\``;
    else if (next() < 0.05) word = `**${word}**`;
    else if (next() < 0.04) word = `\`${word}()\``;
    out.push(word);
  }
  const text = out.join(" ");
  return text[0].toUpperCase() + text.slice(1) + ".";
}

function paragraph(next: () => number): string {
  return Array.from({ length: 2 + Math.floor(next() * 4) }, () => sentence(next)).join(" ");
}

function code(next: () => number, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => {
    const indent = "  ".repeat(Math.floor(next() * 3));
    return `${indent}const value${i} = await host.request("sessions.sync", { sessionId, revision: ${i} });`;
  });
  return "```ts\n" + body.join("\n") + "\n```";
}

export function answer(next: () => number, rich: boolean): string {
  const parts = [paragraph(next)];
  if (rich) {
    parts.push("## What changed");
    parts.push(Array.from({ length: 3 + Math.floor(next() * 3) }, () => `- ${sentence(next, 6 + Math.floor(next() * 8))}`).join("\n"));
    parts.push(code(next, 8 + Math.floor(next() * 50)));
  }
  parts.push(paragraph(next));
  return parts.join("\n\n");
}

/** `turns` settled turns: prompt, a trail of work, then the answer. */
export function fixtureSession(turns: number, seed = 42): Block[] {
  const next = random(seed);
  const blocks: Block[] = [];
  let at = Date.now() - turns * 120_000;
  for (let t = 0; t < turns; t++) {
    const duration = 4_000 + Math.floor(next() * 180_000);
    blocks.push({
      id: `u${t}`,
      role: "user",
      text: sentence(next, 6 + Math.floor(next() * 20)),
      startedAt: at,
      durationMs: duration,
      turnModel: { harness: "claude", id: "claude:opus", name: "Claude Opus 4.6" },
    });
    blocks.push({ id: `r${t}`, role: "reasoning", text: sentence(next) });
    const steps = 2 + Math.floor(next() * 6);
    for (let s = 0; s < steps; s++) {
      const file = FILES[Math.floor(next() * FILES.length)];
      const kind = next();
      blocks.push(
        kind < 0.5
          ? { id: `t${t}.${s}`, role: "tool", text: `Read ${file}`, tool: { kind: "read", status: "completed", preview: { kind: "read", path: file } } }
          : kind < 0.8
            ? { id: `t${t}.${s}`, role: "tool", text: `Edit ${file}`, tool: { kind: "edit", status: "completed", preview: { kind: "write", path: file, additions: 4, deletions: 1 } } }
            : { id: `t${t}.${s}`, role: "tool", text: "npm test -- --run", tool: { kind: "execute", status: "completed", preview: { kind: "shell", output: "✓ 42 tests passed" } } },
      );
    }
    blocks.push({ id: `a${t}`, role: "assistant", text: answer(next, t % 3 === 0) });
    at += duration + 30_000;
  }
  return blocks;
}

/** A live turn that streams text at `charsPerSecond` and adds tool events. */
export function streamScript(seed = 7) {
  const next = random(seed);
  const text = Array.from({ length: 30 }, () => answer(next, next() < 0.4)).join("\n\n");
  return { text, files: FILES };
}
