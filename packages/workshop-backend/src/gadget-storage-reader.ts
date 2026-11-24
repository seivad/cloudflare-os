// The Workshop's own reader of a gadget's stored data. A gadget's storage belongs to its facet, and
// only a class running in that facet can open it, so the Overseer pauses the gadget and starts this
// class under the gadget's facet name in its place (OverseerImpl.readGadgetStorage()). It reads and
// never writes, and answers only the Overseer that started it: each method takes the nonce the
// Overseer put in its props.

import type { GadgetDataFile, GadgetDataValue } from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";
import { describeBytes, MAX_EXPORT_DATA_BYTES } from "./export-limits";

/** What the Overseer starts a GadgetStorageReader with. */
export type GadgetStorageReaderProps = {
  /** A secret the Overseer drew for this read: a call without it is refused. */
  nonce: string;
};

/** What GadgetStorageReader.dump() is asked to copy. */
export type GadgetDumpOptions = {
  /** The gadget, as GadgetDataFile.gadget names it. */
  gadget: GadgetDataFile["gadget"];
  /** When the copy is taken. */
  exportedAt: Date;
  /** The most the encoded copy may hold, in bytes of UTF-8. */
  maxBytes: number;
};

/** A gadget's storage as it reads, before encodeGadgetData() makes it JSON. Tables and keys may be
 * lazy, so that the encoding can stop at its limit without reading the rest. */
export type GadgetStorageDump = {
  gadget: GadgetDataFile["gadget"];
  exportedAt: Date;
  sizeBytes: number;
  sql: Iterable<{
    name: string; createSql: string; rows: Iterable<Record<string, SqlStorageValue>>;
  }>;
  kv: Iterable<[string, unknown]>;
};

/** Refuses a call whose nonce is not the one the reader was started with. */
const REFUSED = "This reader answers only the workspace that started it.";

/**
 * A Durable Object class the Overseer starts as a gadget's facet, in the gadget's storage, while
 * the gadget is paused (see OverseerImpl.readGadgetStorage()). Exported from the Worker so that
 * `ctx.exports.GadgetStorageReader` exists; no binding names it, so nothing but a facet can run it.
 */
export class GadgetStorageReader extends DurableObject<Cloudflare.Env, GadgetStorageReaderProps> {
  #check(nonce: unknown): void {
    if (typeof nonce !== "string" || nonce !== this.ctx.props.nonce) throw new Error(REFUSED);
  }

  /** The size of the gadget's storage, in bytes. */
  measure(nonce: string): number {
    this.#check(nonce);
    return this.ctx.storage.sql.databaseSize;
  }

  /** The gadget's tables and key-value storage as data.json holds them: a GadgetDataFile, as the
   * UTF-8 bytes of its JSON, which cross to the Overseer as one message of exactly that size
   * rather than an object per row and value, or a string that may travel as two bytes a
   * character. Throws once the encoding passes `options.maxBytes`. */
  dump(nonce: string, options: GadgetDumpOptions): Uint8Array {
    this.#check(nonce);
    let sql = this.ctx.storage.sql;
    let tables = sql.exec<{ name: string; sql: string }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY rowid").toArray();
    return encodeDataFile(encodeGadgetData({
      gadget: options.gadget,
      exportedAt: options.exportedAt,
      sizeBytes: sql.databaseSize,
      sql: tables.filter(table => !isInternalTable(table.name)).map(table => ({
        name: table.name,
        createSql: table.sql,
        // Read as the encoding reaches it, so a table past the limit is never read whole.
        rows: { [Symbol.iterator]: () => tableRows(sql, table.name) },
      })),
      kv: this.ctx.storage.kv.list(),
    }, options.maxBytes), options.maxBytes);
  }
}

// The message of a copy past its limit.
function tooLarge(maxBytes: number): Error {
  return new Error(`The gadget's data is larger than ${describeBytes(maxBytes)}, the most a copy ` +
      "holds.");
}

/** data.json as the UTF-8 bytes of its JSON. Throws when they pass `maxBytes`: encodeGadgetData()
 * counts characters of JSON text, which a character outside ASCII takes up to three bytes of. */
export function encodeDataFile(file: GadgetDataFile, maxBytes: number): Uint8Array {
  let bytes = new TextEncoder().encode(JSON.stringify(file));
  if (bytes.byteLength > maxBytes) throw tooLarge(maxBytes);
  return bytes;
}

// A table's rows, each with its columns as own properties: built from the raw cells, since a row
// object the cursor builds loses a column named `__proto__`.
function* tableRows(sql: SqlStorage, name: string): Generator<Record<string, SqlStorageValue>> {
  let cursor = sql.exec(`SELECT * FROM ${quoteIdentifier(name)}`);
  let columns = cursor.columnNames;
  for (let cells of cursor.raw()) {
    yield Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? null]));
  }
}

// A table name as a SQL identifier.
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Whether a table is the runtime's or SQLite's own, which data.json leaves out. The key-value
 * storage's table (`_cf_KV`) is one: it is copied as `kv`. */
export function isInternalTable(name: string): boolean {
  return name.startsWith("_cf_") || name.startsWith("sqlite_");
}

/**
 * Encodes a gadget's storage as data.json holds it (see GadgetDataFile), leaving out internal
 * tables. Throws once the encoded rows and values pass `maxBytes`, counted as JSON text, so a
 * copy that would be larger than an export may hold stops there.
 */
export function encodeGadgetData(dump: GadgetStorageDump, maxBytes = MAX_EXPORT_DATA_BYTES)
    : GadgetDataFile {
  let total = 0;
  let count = (value: unknown) => {
    total += JSON.stringify(value).length;
    if (total > maxBytes) throw tooLarge(maxBytes);
  };

  let sql: GadgetDataFile["sql"] = [];
  for (let table of dump.sql) {
    if (isInternalTable(table.name)) continue;
    let rows: GadgetDataFile["sql"][number]["rows"] = [];
    for (let row of table.rows) {
      // Built with fromEntries, which defines each column as an own property, so a column named
      // `__proto__` is kept rather than setting the row's prototype.
      let encoded: Record<string, GadgetDataValue> = Object.fromEntries(
          Object.entries(row).map(([column, value]) => [column, encodeSqlValue(value)]));
      count(encoded);
      rows.push(encoded);
    }
    sql.push({ name: table.name, createSql: table.createSql, rows });
  }

  let kv: GadgetDataFile["kv"] = [];
  for (let [key, value] of dump.kv) {
    let entry = { key, value: encodeKvValue(value) };
    count(entry);
    kv.push(entry);
  }

  return {
    format: "cloudflare-os/gadget-data",
    version: 1,
    gadget: dump.gadget,
    exportedAt: dump.exportedAt.toISOString(),
    sizeBytes: dump.sizeBytes,
    sql,
    kv,
  };
}

/** A SQLite cell as JSON: a BLOB as `$bytes`, a number JSON cannot hold as `$number`. */
export function encodeSqlValue(value: SqlStorageValue): GadgetDataValue {
  if (value instanceof ArrayBuffer) return { $bytes: new Uint8Array(value).toBase64() };
  if (typeof value === "number") return encodeNumber(value);
  return value;
}

/** A key-value value, which the runtime stores as structured-clone data, as JSON. Throws for a
 * value that refers to itself, which JSON cannot hold. */
export function encodeKvValue(value: unknown, ancestors = new Set<object>()): GadgetDataValue {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return encodeNumber(value);
    case "bigint":
      return { $bigint: value.toString() };
    case "undefined":
      return { $undefined: true };
  }
  if (value === null) return null;
  if (typeof value !== "object") {
    throw new TypeError(`A stored value of type ${typeof value} cannot be copied.`);
  }

  if (value instanceof Uint8Array) return { $bytes: value.toBase64() };
  if (value instanceof ArrayBuffer) return { $arrayBuffer: new Uint8Array(value).toBase64() };
  if (ArrayBuffer.isView(value)) {
    let bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { $typedArray: { type: value.constructor.name, bytes: bytes.toBase64() } };
  }
  if (value instanceof Date) {
    return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  }
  if (value instanceof RegExp) return { $regexp: { source: value.source, flags: value.flags } };
  if (value instanceof Error) return { $error: { name: value.name, message: value.message } };

  if (ancestors.has(value)) {
    throw new TypeError("A stored value refers to itself, which a JSON copy cannot hold.");
  }
  ancestors.add(value);
  try {
    let encode = (item: unknown) => encodeKvValue(item, ancestors);
    if (value instanceof Map) {
      return { $map: [...value].map(([key, item]) => [encode(key), encode(item)]) };
    }
    if (value instanceof Set) return { $set: [...value].map(encode) };
    if (Array.isArray(value)) return Array.from(value, encode);
    let entries = Object.entries(value).map(([key, item]) => [key, encode(item)] as const);
    let object = Object.fromEntries(entries);
    // An object with a key that reads as a tag is wrapped, so that it never is read as one.
    return entries.some(([key]) => key.startsWith("$")) ? { $object: object } : object;
  } finally {
    ancestors.delete(value);
  }
}

// A number as JSON, tagged when JSON cannot hold it.
function encodeNumber(value: number): GadgetDataValue {
  if (Object.is(value, -0)) return { $number: "-0" };
  return Number.isFinite(value) ? value : { $number: String(value) };
}
