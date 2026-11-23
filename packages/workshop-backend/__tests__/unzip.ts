// Reading a ZIP back as an unzip tool would, for the tests of what the Workshop zips.

import { expect } from "vitest";

/** A ZIP's entries as bytes, read from its central directory and inflated: what an unzip tool
 * sees. Checks that each local header agrees with its central one and that each checksum holds. */
export async function unzipBytes(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  expect(view.getUint16(end + 8, true)).toBe(count);
  let at = view.getUint32(end + 16, true);
  expect(at + view.getUint32(end + 12, true)).toBe(end);
  const entries = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    expect(view.getUint32(local + 18, true)).toBe(packedSize);
    expect(view.getUint32(local + 22, true)).toBe(size);
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    expect(method).toBe(8);
    const inflated = new Blob([bytes.subarray(dataAt, dataAt + packedSize)]).stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
    const content = new Uint8Array(await new Response(inflated).arrayBuffer());
    expect(content.byteLength).toBe(size);
    expect(crc32(content)).toBe(crc);
    entries.set(name, content);
    at += 46 + nameLength;
  }
  return entries;
}

// A plain bitwise CRC-32, independent of the writer's table.
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
