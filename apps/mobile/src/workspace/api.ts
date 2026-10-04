// Workspace reads through a host runtime (06 §6.5): files.list, files.read,
// files.search, git.index and git.fileDiff. Every call carries the project
// and, for a session's working copy, its `cwd`.

import type { HostRuntime } from "@/hosts/runtime";
import { sortEntries } from "./paths";
import { scopeParams, type FileEntry, type GitDiffIndex, type GitFileDiff, type Scope } from "./types";

type Reader = Pick<HostRuntime, "request">;

/** The host's `files.read` cap, enforced again on the phone. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Binary, oversized and unreadable files (11 §11.20). */
export const CANT_SHOW = "This file can't be shown on the phone.";

export async function listFiles(host: Reader, scope: Scope, path: string): Promise<FileEntry[]> {
  return sortEntries(await host.request<FileEntry[]>("files.list", { ...scopeParams(scope), path }));
}

/** Go to file: up to 200 paths containing `query`. */
export function searchFiles(host: Reader, scope: Scope, query: string): Promise<FileEntry[]> {
  return host.request<FileEntry[]>("files.search", { ...scopeParams(scope), query });
}

export function readFile(host: Reader, scope: Scope, path: string): Promise<string> {
  return host.request<string>("files.read", { ...scopeParams(scope), path });
}

export function gitIndex(host: Reader, scope: Scope): Promise<GitDiffIndex> {
  return host.request<GitDiffIndex>("git.index", scopeParams(scope));
}

export function fileDiff(host: Reader, scope: Scope, path: string, staged: boolean): Promise<GitFileDiff> {
  return host.request<GitFileDiff>("git.fileDiff", { ...scopeParams(scope), path, staged });
}

/** UTF-8 length without encoding. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** `files.read` refusals for a file the phone can't show, so not worth a
 * retry: the host's messages for oversized and binary files. */
export function cantShowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^(File is too large to preview|Binary file cannot be previewed)/.test(message);
}

/** The text when the phone can show it: a string, no NUL bytes, at most 1 MiB. */
export function viewableText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  return utf8Length(value) > MAX_FILE_BYTES ? undefined : value;
}
