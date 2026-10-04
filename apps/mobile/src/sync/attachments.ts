// Image attachments (12 §12.10): `attachments.read` returns base64 chunks
// whose non-final sizes are multiples of three bytes, so the chunks join
// into one base64 string. Shown with expo-image as a data URI.

export type ReadChunk = { data: string; offset: number; size: number };
export type ReadRequest = (params: { sessionId: string; id: string; offset: number }) => Promise<ReadChunk>;

/** Reads a whole attachment. `onProgress` gets bytes read and the total. */
export async function readAttachment(
  request: ReadRequest,
  sessionId: string,
  id: string,
  onProgress?: (read: number, size: number) => void,
): Promise<{ base64: string; size: number }> {
  const parts: string[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await request({ sessionId, id, offset });
    if (chunk.offset < offset || chunk.offset > chunk.size) throw new Error("The machine sent an invalid attachment chunk.");
    parts.push(chunk.data);
    onProgress?.(chunk.offset, chunk.size);
    if (chunk.offset >= chunk.size) return { base64: parts.join(""), size: chunk.size };
    // No progress means the file changed or was cut short on the machine.
    if (chunk.offset === offset) throw new Error("The attachment is incomplete on the machine.");
    offset = chunk.offset;
  }
}

/** Decoded images stay in memory up to this many base64 characters; the
 * expo-image disk cache (200 MiB) keeps them across launches. */
const MEMORY_CHARS = 24 * 1024 * 1024;
const memory = new Map<string, string>();
const loading = new Map<string, Promise<string>>();

function remember(key: string, uri: string): void {
  memory.delete(key);
  memory.set(key, uri);
  let total = 0;
  for (const value of memory.values()) total += value.length;
  for (const [oldest, value] of memory) {
    if (total <= MEMORY_CHARS || oldest === key) break;
    memory.delete(oldest);
    total -= value.length;
  }
}

/** A data URI for one image, read once per launch. */
export function attachmentUri(
  key: string,
  mimeType: string,
  read: (onProgress: (read: number, size: number) => void) => Promise<{ base64: string }>,
  onProgress: (read: number, size: number) => void,
): Promise<string> {
  const hit = memory.get(key);
  if (hit) {
    remember(key, hit);
    return Promise.resolve(hit);
  }
  const running = loading.get(key);
  if (running) return running;
  const work = read(onProgress)
    .then(({ base64 }) => {
      const uri = `data:${mimeType};base64,${base64}`;
      remember(key, uri);
      return uri;
    })
    .finally(() => loading.delete(key));
  loading.set(key, work);
  return work;
}
