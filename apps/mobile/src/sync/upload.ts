// Attachment uploads (12 §12.10 step 4): base64 chunks through
// `attachments.upload {id, offset, size, data}`. The host checks offsets, so
// a repeat is harmless and an interrupted upload resumes from the last offset
// it acknowledged. Pure.

/** The host's limits (`host/attachments.ts`). */
export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** 512 KiB, rounded down to whole base64 groups so chunks slice cleanly. */
export const CHUNK_BYTES = 3 * Math.floor((512 * 1024) / 3);

export type UploadRequest = (params: { id: string; offset: number; size: number; data: string }) => Promise<{ offset: number }>;

/** Decoded length of a base64 string. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** Uploads `base64` from `from` (a byte offset the host acknowledged).
 * Resolves with the final offset, which equals the size when done. */
export async function uploadBase64(
  request: UploadRequest,
  file: { id: string; base64: string },
  options: { from?: number; onProgress?: (offset: number, size: number) => void } = {},
): Promise<number> {
  const size = base64Bytes(file.base64);
  if (size > MAX_ATTACHMENT_BYTES) throw new Error("Files can be up to 20 MB.");
  let offset = options.from ?? 0;
  if (offset % 3 && offset !== size) throw new Error("Upload offsets must fall on whole base64 groups.");
  // An empty file is one empty chunk, so the host creates it.
  do {
    const start = (offset / 3) * 4;
    const data = file.base64.slice(start, start + (CHUNK_BYTES / 3) * 4);
    const result = await request({ id: file.id, offset, size, data });
    if (result.offset <= offset && size > 0) throw new Error("The machine didn’t accept the upload.");
    offset = result.offset;
    options.onProgress?.(offset, size);
  } while (offset < size);
  return offset;
}
