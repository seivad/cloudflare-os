// Writing ZIP archives, for the Workshop's server and its browser alike: a gadget exported as a
// Cloudflare Worker project, an admin's copy of a gadget, and the browser's ZIP of several of
// those.
// Only what every platform has is used (CompressionStream, Blob, TextEncoder), so nothing here
// needs a library.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** General-purpose flag bit 11: the entry's name is UTF-8. */
const UTF8_NAMES = 0x0800;
/** 1980-01-01 00:00 as MS-DOS keeps a date: the files carry no time of their own. */
const DOS_DATE = 0x0021;

/** The most a ZIP without the Zip64 extension can describe: entries, and bytes of an entry or of
 * the archive. */
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

/**
 * A ZIP of the given files, in the order given, by path: a string is stored as its UTF-8 text,
 * bytes as they are. Each entry is deflated whole first, so its sizes and checksum go in its own
 * header, which every unzip tool reads. The archive is built in memory, so it suits what fits in
 * memory several times over; it has no Zip64 extension, so it throws for more than 65,535 files or
 * a file or archive of 4 GiB or more.
 */
export async function zipFiles(files: ReadonlyMap<string, string | Uint8Array>)
    : Promise<Uint8Array> {
  if (files.size > MAX_ENTRIES) {
    throw new RangeError(`A ZIP holds at most ${MAX_ENTRIES} files.`);
  }
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, content] of files) {
    const name = encoder.encode(path);
    const raw = typeof content === "string" ? encoder.encode(content) : content;
    const packed = await deflate(raw);
    if (raw.length > MAX_BYTES || packed.length > MAX_BYTES) {
      throw new RangeError(`${path} is too large for a ZIP.`);
    }
    // Shared by the local header (from its byte 4) and the central one (from its byte 6).
    const fields = new DataView(new ArrayBuffer(26));
    fields.setUint16(0, 20, true);  // version needed: 2.0
    fields.setUint16(2, UTF8_NAMES, true);
    fields.setUint16(4, 8, true);  // method: deflate
    fields.setUint16(6, 0, true);  // time
    fields.setUint16(8, DOS_DATE, true);
    fields.setUint32(10, crc32(raw), true);
    fields.setUint32(14, packed.length, true);
    fields.setUint32(18, raw.length, true);
    fields.setUint16(22, name.length, true);
    fields.setUint16(24, 0, true);  // extra field length
    const shared = new Uint8Array(fields.buffer);

    const local = new Uint8Array(30 + name.length);
    new DataView(local.buffer).setUint32(0, 0x04034b50, true);
    local.set(shared, 4);
    local.set(name, 30);

    const header = new Uint8Array(46 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, (3 << 8) | 20, true);  // made on Unix, so the mode below is read
    header.set(shared, 6);
    // Comment length, disk and internal attributes stay zero. A regular file, rw-r--r--.
    view.setUint32(38, (0o100644 << 16) >>> 0, true);
    view.setUint32(42, offset, true);
    header.set(name, 46);

    parts.push(local, packed);
    central.push(header);
    offset += local.length + packed.length;
    if (offset > MAX_BYTES) throw new RangeError("The files are too large for one ZIP.");
  }
  const centralSize = central.reduce((sum, header) => sum + header.length, 0);
  if (offset + centralSize > MAX_BYTES) {
    throw new RangeError("The files are too large for one ZIP.");
  }
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, central.length, true);
  view.setUint16(10, central.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...parts, ...central, end]).arrayBuffer());
}

/**
 * A file name for something titled `title`: lower-case ASCII letters and digits in runs joined by
 * single hyphens, at most 54 characters, an accented letter keeping its letter. `fallback` when the
 * title has none of those. A Worker project's directory and Worker name, and the names an admin's
 * copy of a gadget gives its files, are made this way.
 */
export function fileNameSlug(title: string, fallback = "gadget"): string {
  const slug = title
    .normalize("NFKD")
    // An accented letter keeps its letter: the accent, now a mark of its own, is dropped.
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54)
    .replace(/-+$/, "");
  return slug || fallback;
}
