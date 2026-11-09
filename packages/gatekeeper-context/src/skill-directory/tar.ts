// A streaming reader for the tar archives `git archive` produces (ustar, with pax and GNU long-name
// extensions). Bodies are skipped unless the visitor asks for them, so a whole repository archive is
// scanned without holding it in memory.

import { SkillDirectoryError } from "./sources.js";

export type TarEntryType = "file" | "directory" | "symlink" | "hardlink" | "other";

export type TarEntry = {
  /** The path as stored, before any normalization. */
  path: string;
  type: TarEntryType;
  size: number;
};

export type TarVisitor = {
  /** A pax global header record; `git archive` stores the commit id as `comment`. */
  onGlobalHeader?(records: ReadonlyMap<string, string>): void;
  /** Return a byte limit to receive the body through `onBody`, or null to skip it. */
  onEntry(entry: TarEntry): number | null;
  onBody?(entry: TarEntry, body: Uint8Array): void;
};

const BLOCK = 512;
// Extended headers hold paths and link targets; bound them so a crafted archive cannot exhaust
// memory before the first entry.
const MAX_EXTENDED_HEADER_BYTES = 1_000_000;
const textDecoder = new TextDecoder();

function malformed(): SkillDirectoryError {
  return new SkillDirectoryError("The repository archive could not be read.");
}

/** Pulls exact byte counts from a stream, buffering only what a single read needs. */
class ByteReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunks: Uint8Array[] = [];
  #available = 0;
  #done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async #fill(count: number): Promise<void> {
    while (this.#available < count && !this.#done) {
      let result = await this.#reader.read();
      if (result.done) {
        this.#done = true;
      } else if (result.value.byteLength > 0) {
        this.#chunks.push(result.value);
        this.#available += result.value.byteLength;
      }
    }
  }

  /** Exactly `count` bytes, or null at a clean end of stream. */
  async read(count: number): Promise<Uint8Array | null> {
    await this.#fill(count);
    if (this.#available === 0 && this.#done) return null;
    if (this.#available < count) throw malformed();
    let result = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      let chunk = this.#chunks[0];
      let take = Math.min(chunk.byteLength, count - offset);
      result.set(chunk.subarray(0, take), offset);
      offset += take;
      this.#consume(take);
    }
    return result;
  }

  async skip(count: number): Promise<void> {
    let remaining = count;
    while (remaining > 0) {
      await this.#fill(1);
      if (this.#available === 0) throw malformed();
      let take = Math.min(this.#chunks[0].byteLength, remaining);
      this.#consume(take);
      remaining -= take;
    }
  }

  #consume(count: number): void {
    let chunk = this.#chunks[0];
    if (count === chunk.byteLength) this.#chunks.shift();
    else this.#chunks[0] = chunk.subarray(count);
    this.#available -= count;
  }

  /** Read and discard the rest of the stream, so a caller recording it sees every byte. */
  async drain(): Promise<void> {
    this.#chunks = [];
    this.#available = 0;
    while (!this.#done) {
      let { done } = await this.#reader.read();
      if (done) this.#done = true;
    }
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => {});
  }
}

function cString(block: Uint8Array, start: number, length: number): string {
  let end = start;
  while (end < start + length && block[end] !== 0) end++;
  return textDecoder.decode(block.subarray(start, end));
}

function numberField(block: Uint8Array, start: number, length: number): number {
  // Base-256 encoding (high bit set) carries values too large for octal.
  if (block[start] & 0x80) {
    let value = block[start] & 0x7f;
    for (let i = start + 1; i < start + length; i++) value = value * 256 + block[i];
    if (!Number.isSafeInteger(value)) throw malformed();
    return value;
  }
  let text = cString(block, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw malformed();
  return parseInt(text, 8);
}

function checksumMatches(block: Uint8Array): boolean {
  let expected = numberField(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  return sum === expected;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let byte of block) if (byte !== 0) return false;
  return true;
}

/** Records of a pax extended header: `<length> <key>=<value>\n` each. */
function paxRecords(body: Uint8Array): Map<string, string> {
  let records = new Map<string, string>();
  let offset = 0;
  while (offset < body.byteLength) {
    let space = body.indexOf(0x20, offset);
    if (space < 0) throw malformed();
    let length = Number(textDecoder.decode(body.subarray(offset, space)));
    if (!Number.isInteger(length) || length <= 0 || offset + length > body.byteLength) throw malformed();
    let record = textDecoder.decode(body.subarray(space + 1, offset + length - 1));
    let equals = record.indexOf("=");
    if (equals < 0) throw malformed();
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

function entryType(flag: number): TarEntryType {
  switch (String.fromCharCode(flag)) {
    case "0": case "\0": case "7": return "file";
    case "5": return "directory";
    case "2": return "symlink";
    case "1": return "hardlink";
    default: return "other";
  }
}

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

/** Visit every entry of an uncompressed tar stream, then drain the stream. */
export async function scanTar(stream: ReadableStream<Uint8Array>, visitor: TarVisitor): Promise<void> {
  let reader = new ByteReader(stream);
  try {
    let pendingPax: Map<string, string> | null = null;
    let pendingLongName: string | null = null;
    for (;;) {
      let block = await reader.read(BLOCK);
      if (block === null || isZeroBlock(block)) break;
      if (!checksumMatches(block)) throw malformed();

      let flag = String.fromCharCode(block[156]);
      let size = numberField(block, 124, 12);
      if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
        if (size > MAX_EXTENDED_HEADER_BYTES) throw malformed();
        let body = await reader.read(size);
        if (body === null) throw malformed();
        await reader.skip(padding(size));
        if (flag === "g") visitor.onGlobalHeader?.(paxRecords(body));
        else if (flag === "x") pendingPax = paxRecords(body);
        else if (flag === "L") pendingLongName = cString(body, 0, body.byteLength);
        // 'K' is a GNU long link target, which nothing here reads.
        continue;
      }

      let name = cString(block, 0, 100);
      let magic = cString(block, 257, 6);
      // POSIX ustar splits long paths into a prefix; GNU tar ("ustar  ") reuses those bytes.
      if (magic === "ustar" && block[262] === 0) {
        let prefix = cString(block, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
      }
      let path = pendingPax?.get("path") ?? pendingLongName ?? name;
      let paxSize = pendingPax?.get("size");
      if (paxSize !== undefined) {
        if (!/^\d+$/.test(paxSize)) throw malformed();
        size = Number(paxSize);
      }
      pendingPax = null;
      pendingLongName = null;

      let entry: TarEntry = { path, type: entryType(block[156]), size };
      // Only regular files carry a body that matters; anything else is skipped whatever its size.
      let limit = visitor.onEntry(entry);
      if (limit !== null && entry.type === "file" && size <= limit) {
        let body = size === 0 ? new Uint8Array(0) : await reader.read(size);
        if (body === null) throw malformed();
        visitor.onBody?.(entry, body);
      } else {
        await reader.skip(size);
      }
      await reader.skip(padding(size));
    }
    await reader.drain();
  } catch (error) {
    await reader.cancel();
    throw error;
  }
}
