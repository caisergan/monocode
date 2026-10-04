import { describe, expect, it } from "vitest";
import { CHUNK_BYTES, base64Bytes, uploadBase64, type UploadRequest } from "../upload";

/** The host's offset rules (`writeAttachmentChunk`), in memory. */
function host(failAt?: number) {
  const file = { bytes: Buffer.alloc(0) };
  const calls: { offset: number; length: number }[] = [];
  let failed = false;
  const request: UploadRequest = async ({ offset, size, data }) => {
    calls.push({ offset, length: data.length });
    if (failAt !== undefined && offset === failAt && !failed) {
      failed = true;
      throw Object.assign(new Error("Connection lost"), { code: "offline", retryable: true });
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > 512 * 1024 || offset + bytes.length > size) throw new Error("Invalid attachment chunk size");
    if (offset > file.bytes.length) throw new Error("Attachment chunks are out of order");
    file.bytes = Buffer.concat([file.bytes.subarray(0, offset), bytes, file.bytes.subarray(offset + bytes.length)]);
    return { offset: offset + bytes.length };
  };
  return { request, file, calls };
}

describe("attachment upload", () => {
  const bytes = Buffer.from(Array.from({ length: CHUNK_BYTES * 2 + 1000 }, (_, i) => i % 251));
  const base64 = bytes.toString("base64");

  it("sends whole-group chunks of at most 512 KiB", async () => {
    const { request, file, calls } = host();
    let progress = 0;
    const end = await uploadBase64(request, { id: "f", base64 }, { onProgress: (offset) => (progress = offset) });
    expect(end).toBe(bytes.length);
    expect(progress).toBe(bytes.length);
    expect(calls.map((call) => call.offset)).toEqual([0, CHUNK_BYTES, CHUNK_BYTES * 2]);
    expect(file.bytes.equals(bytes)).toBe(true);
    expect(base64Bytes(base64)).toBe(bytes.length);
  });

  it("resumes from the last acknowledged offset", async () => {
    const { request, file } = host(CHUNK_BYTES);
    let acked = 0;
    await expect(uploadBase64(request, { id: "f", base64 }, { onProgress: (offset) => (acked = offset) })).rejects.toThrow("Connection lost");
    expect(acked).toBe(CHUNK_BYTES);
    await uploadBase64(request, { id: "f", base64 }, { from: acked });
    expect(file.bytes.equals(bytes)).toBe(true);
  });

  it("uploads an empty file as one empty chunk", async () => {
    const { request, calls } = host();
    expect(await uploadBase64(request, { id: "e", base64: "" })).toBe(0);
    expect(calls).toEqual([{ offset: 0, length: 0 }]);
  });
});
