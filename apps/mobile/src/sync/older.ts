// Older history for an open session (06 §6.7): `sessions.blocks` returns
// the turns before the window's first block, which the phone prepends. The
// first returned block becomes the anchor the next `watch.set` carries.

import type { Block, HostSession } from "@monocode/core/session";
import type { WindowMeta } from "@monocode/core/wire";

export type OlderPage = { blocks: Block[]; olderTurns: number; hasOlder?: boolean; revision?: number };

export type WindowValue = { value: HostSession; window?: WindowMeta };

/** Prepends an older page. `before` is the block the request was made
 * against: if the window no longer starts there (a snapshot replaced it
 * meanwhile), the page is stale and the result is undefined. */
export function mergeOlder(current: WindowValue, before: string, page: OlderPage): WindowValue | undefined {
  const blocks = current.value.session.blocks;
  if (blocks[0]?.id !== before) return undefined;
  const known = new Set(blocks.map((block) => block.id));
  const older = page.blocks.filter((block) => !known.has(block.id));
  const merged = older.length ? [...older, ...blocks] : blocks;
  const olderTurns = Math.max(0, page.olderTurns);
  const window: WindowMeta = {
    anchor: merged[0]?.id ?? null,
    olderTurns,
    olderBlocks: olderTurns === 0 ? 0 : Math.max(0, (current.window?.olderBlocks ?? older.length) - older.length),
  };
  return {
    value: older.length ? { ...current.value, session: { ...current.value.session, blocks: merged } } : current.value,
    window,
  };
}

export function hasOlder(window: WindowMeta | undefined): boolean {
  return (window?.olderTurns ?? 0) > 0;
}
