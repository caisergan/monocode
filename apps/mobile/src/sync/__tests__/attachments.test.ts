import { describe, expect, it } from "vitest";
import { readAttachment, type ReadChunk } from "../attachments";

/** Serves `bytes` the way the host does: chunks of `chunk` bytes (a
 * multiple of three), base64 encoded. */
function host(bytes: Uint8Array, chunk: number) {
  const calls: number[] = [];
  const request = async ({ offset }: { offset: number }): Promise<ReadChunk> => {
    calls.push(offset);
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + chunk));
    return { data: Buffer.from(slice).toString("base64"), offset: offset + slice.length, size: bytes.length };
  };
  return { request, calls };
}

describe("attachment reads", () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);

  it("joins chunks into one base64 string", async () => {
    const { request, calls } = host(bytes, 300);
    const progress: number[] = [];
    const result = await readAttachment(request, "s1", "a1", (read) => progress.push(read));
    expect(Buffer.from(result.base64, "base64")).toEqual(Buffer.from(bytes));
    expect(result.size).toBe(1000);
    expect(calls).toEqual([0, 300, 600, 900]);
    expect(progress).toEqual([300, 600, 900, 1000]);
  });

  it("reads a small file in one call", async () => {
    const { request, calls } = host(bytes.subarray(0, 10), 300);
    expect(Buffer.from((await readAttachment(request, "s1", "a1")).base64, "base64")).toHaveLength(10);
    expect(calls).toEqual([0]);
  });

  it("stops when the machine makes no progress", async () => {
    const stuck = async () => ({ data: "", offset: 0, size: 10 });
    await expect(readAttachment(stuck, "s1", "a1")).rejects.toThrow("incomplete");
  });

  it("rejects offsets that go backwards", async () => {
    let call = 0;
    const odd = async () => (call++ ? { data: "", offset: 1, size: 10 } : { data: "AAAA", offset: 3, size: 10 });
    await expect(readAttachment(odd, "s1", "a1")).rejects.toThrow("invalid");
  });
});
