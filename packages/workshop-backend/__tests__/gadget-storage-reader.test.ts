// Reading a gadget's stored data (gadget-storage-reader.ts, OverseerImpl.readGadgetStorage()):
// data.json's encoding, the reader refusing anyone without its nonce, and the Overseer's read of a
// real gadget facet -- paused while the Workshop's reader takes its place, every path to the
// gadget waiting for it, and the gadget back with its data on every path out.
//
// Runs a real gadget, loaded from a real commit, inside a real OverseerDurableObject.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { GadgetDataFile } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import {
  encodeDataFile, encodeGadgetData, encodeKvValue,
} from "../src/gadget-storage-reader.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const bytesOf = (...values: number[]) => new Uint8Array(values);

describe("encodeGadgetData", () => {
  const dump = (sql: { name: string; createSql: string; rows: Record<string, SqlStorageValue>[] }[],
                kv: [string, unknown][] = []) => ({
    gadget: { id: 3, name: "Notes" }, exportedAt: new Date(Date.UTC(2026, 10, 23, 10)),
    sizeBytes: 12288, sql, kv,
  });

  it("keeps each table's rows and createSql, BLOBs as $bytes, and skips internal tables", () => {
    let file = encodeGadgetData(dump([
      { name: "notes", createSql: "CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT, b BLOB)",
        rows: [{ id: 1, body: "hello", b: bytesOf(0, 1, 255).buffer },
               { id: 2, body: null, b: null }] },
      { name: "_cf_KV", createSql: "CREATE TABLE _cf_KV(key TEXT, value BLOB)",
        rows: [{ key: "k", value: bytesOf(1).buffer }] },
      { name: "sqlite_sequence", createSql: "CREATE TABLE sqlite_sequence(name, seq)",
        rows: [{ name: "notes", seq: 2 }] },
      { name: "odd", createSql: "CREATE TABLE odd(x REAL)",
        rows: [{ x: Infinity }, { x: -Infinity }, { x: NaN }, { x: -0 }, { x: 1.5 }] },
    ]));
    expect(file).toStrictEqual({
      format: "cloudflare-os/gadget-data",
      version: 1,
      gadget: { id: 3, name: "Notes" },
      exportedAt: "2026-11-23T10:00:00.000Z",
      sizeBytes: 12288,
      sql: [
        { name: "notes", createSql: "CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT, b BLOB)",
          rows: [{ id: 1, body: "hello", b: { $bytes: "AAH/" } }, { id: 2, body: null, b: null }] },
        { name: "odd", createSql: "CREATE TABLE odd(x REAL)",
          rows: [{ x: { $number: "Infinity" } }, { x: { $number: "-Infinity" } },
                 { x: { $number: "NaN" } }, { x: { $number: "-0" } }, { x: 1.5 }] },
      ],
      kv: [],
    } satisfies GadgetDataFile);
    // JSON all through.
    expect(JSON.parse(JSON.stringify(file))).toStrictEqual(file);
  });

  it("tags each key-value value JSON cannot hold", () => {
    let file = encodeGadgetData(dump([], [
      ["plain", { a: 1, b: [true, "x", null] }],
      ["bytes", bytesOf(1, 2, 3)],
      ["date", new Date(0)],
      ["invalidDate", new Date(NaN)],
      ["map", new Map<unknown, unknown>([[1, "one"], ["two", new Set([2n])]])],
      ["set", new Set(["a", "b"])],
      ["big", 12345678901234567890n],
      ["undef", undefined],
      ["buffer", bytesOf(9).buffer],
      ["floats", new Float64Array([0.5])],
      ["regexp", /ab+c/gi],
      ["error", new RangeError("too far")],
      ["dollar", { $bytes: "not a tag" }],
      ["nested", { list: [new Date(1000), { $x: 1 }] }],
    ]));
    expect(file.kv).toStrictEqual([
      { key: "plain", value: { a: 1, b: [true, "x", null] } },
      { key: "bytes", value: { $bytes: "AQID" } },
      { key: "date", value: { $date: "1970-01-01T00:00:00.000Z" } },
      { key: "invalidDate", value: { $date: null } },
      { key: "map", value: { $map: [[1, "one"], ["two", { $set: [{ $bigint: "2" }] }]] } },
      { key: "set", value: { $set: ["a", "b"] } },
      { key: "big", value: { $bigint: "12345678901234567890" } },
      { key: "undef", value: { $undefined: true } },
      { key: "buffer", value: { $arrayBuffer: "CQ==" } },
      { key: "floats", value: { $typedArray: { type: "Float64Array", bytes: "AAAAAAAA4D8=" } } },
      { key: "regexp", value: { $regexp: { source: "ab+c", flags: "gi" } } },
      { key: "error", value: { $error: { name: "RangeError", message: "too far" } } },
      { key: "dollar", value: { $object: { $bytes: "not a tag" } } },
      { key: "nested", value: { list: [{ $date: "1970-01-01T00:00:01.000Z" },
                                       { $object: { $x: 1 } }] } },
    ]);
  });

  it("keeps a column named __proto__ as a column", () => {
    // JSON.parse makes `__proto__` an own property, as a SQL row's column is.
    let row = JSON.parse('{"id": 1, "__proto__": "kept"}');
    let file = encodeGadgetData(dump([
      { name: "odd", createSql: 'CREATE TABLE odd(id, "__proto__")', rows: [row] },
    ]));
    let [encoded] = file.sql[0]!.rows;
    expect(Object.hasOwn(encoded!, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(file)).sql[0].rows)
        .toStrictEqual([JSON.parse('{"id": 1, "__proto__": "kept"}')]);
  });

  it("refuses a value that refers to itself, and allows one shared twice", () => {
    let shared = { n: 1 };
    expect(encodeKvValue({ a: shared, b: shared })).toStrictEqual({ a: { n: 1 }, b: { n: 1 } });
    let cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeKvValue(cyclic)).toThrow("refers to itself");
  });

  it("stops at its byte limit without reading the rest", () => {
    let read = 0;
    function* rows() {
      for (let id = 0; id < 1000; id++) {
        read++;
        yield { id, body: "x".repeat(100) };
      }
    }
    expect(() => encodeGadgetData(
        dump([{ name: "big", createSql: "CREATE TABLE big(id, body)", rows: rows() as any }]),
        1000)).toThrow("larger than 1000 bytes");
    expect(read).toBeLessThan(20);
  });
});

describe("encodeDataFile", () => {
  const file = (body: string): GadgetDataFile => ({
    format: "cloudflare-os/gadget-data", version: 1, gadget: { id: 3, name: "Notes" },
    exportedAt: "2026-11-23T10:00:00.000Z", sizeBytes: 12288,
    sql: [{ name: "notes", createSql: "CREATE TABLE notes(body)", rows: [{ body }] }], kv: [],
  });

  it("writes the file as UTF-8 JSON", () => {
    let bytes = encodeDataFile(file("caf\u00e9"), 1000);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toStrictEqual(file("caf\u00e9"));
  });

  it("refuses a file whose UTF-8 bytes pass the limit, though its JSON text is within it", () => {
    // 300 characters of JSON text for the body, 900 bytes of UTF-8.
    let text = JSON.stringify(file("\u20ac".repeat(300)));
    expect(text.length).toBeLessThan(600);
    expect(() => encodeDataFile(file("\u20ac".repeat(300)), 600))
        .toThrow("The gadget's data is larger than 600 bytes");
  });
});

const GADGET_ID = 1;

// A gadget that keeps notes in SQL and a counter in its key-value storage.
const SERVER_JS = `
import { DurableObject, RpcTarget, restore } from "cloudflare:workers";

export class Gadget extends DurableObject {
  add(body) {
    this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, body TEXT, raw BLOB)");
    this.ctx.storage.sql.exec("INSERT INTO notes(body, raw) VALUES (?, ?)", body,
        new Uint8Array([1, 2, 3]));
    this.ctx.storage.kv.put("count", (this.ctx.storage.kv.get("count") ?? 0) + 1);
    this.ctx.storage.kv.put("seen", new Map([[body, new Date(0)]]));
    return this.notes();
  }

  notes() {
    return this.ctx.storage.sql.exec("SELECT body FROM notes ORDER BY id").toArray()
        .map(row => row.body);
  }

  whoami() {
    return "gadget";
  }

  addOdd(value) {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS odd("__proto__" TEXT)');
    this.ctx.storage.sql.exec('INSERT INTO odd("__proto__") VALUES (?)', value);
  }

  addCycle() {
    let value = {};
    value.self = value;
    this.ctx.storage.kv.put("cycle", value);
  }

  addSearch(body) {
    this.ctx.storage.sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(body)");
    this.ctx.storage.sql.exec("INSERT INTO search(body) VALUES (?)", body);
  }

  addBig() {
    this.ctx.storage.sql.exec("CREATE TABLE big(n INTEGER)");
    this.ctx.storage.sql.exec("INSERT INTO big VALUES (9007199254740993)");
  }

  mintCallback() {
    return this.ctx.restore({ type: "callback" });
  }

  [restore](params) {
    return new Callback(this);
  }
}

class Callback extends RpcTarget {
  constructor(gadget) {
    super();
    this.gadget = gadget;
  }
  notes() {
    return this.gadget.notes();
  }
}
`;

let doCounter = 0;

async function withGadget(fn: (impl: any) => Promise<void>,
                          record: Record<string, unknown> = {}): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`gadget-storage-reader-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let commitId = await impl.gitCache.writeFilesAsCommit(new Map([["server.js", SERVER_JS]]), {
      parents: [],
      author: { name: "Alice", email: "alice@example.com" },
      message: "test commit",
      timestamp: new Date(1700000000_000),
    });
    impl.storage.gadgets.put({
      type: "gadget", id: GADGET_ID, title: "Notes", created: new Date(0), bindingName: "NOTES",
      bindings: {}, commitId, ...record,
    });
    await fn(impl);
  });
}

// The gadget's facet, as every caller reaches it.
const gadgetOf = (impl: any): Promise<any> => impl.getGadgetFacet(GADGET_ID);

// Await a stub call's rejection with a single handler, returning its message: expect(...).rejects
// forks the underlying JsRpcPromise, and the leftover copy is reported as an unhandled rejection
// (see overseer-hooks.test.ts).
async function rejection(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (err) {
    return String(err);
  }
  throw new Error("expected the call to reject");
}

describe("the storage reader", () => {
  it("answers no one without the nonce it was started with", () =>
      withGadget(async impl => {
    // Started as the Overseer starts it, under a facet name no gadget has.
    let reader = impl.ctx.facets.get("reader-probe", () => ({
      class: impl.ctx.exports.GadgetStorageReader({ props: { nonce: "right" } }),
      id: "reader-probe",
    }));
    expect(await rejection(reader.measure("wrong"))).toContain("answers only the workspace");
    expect(await rejection(reader.measure(undefined))).toContain("answers only the workspace");
    expect(await rejection(reader.dump("wrong", {
      gadget: { id: 0, name: "" }, exportedAt: new Date(), maxBytes: 1000,
    }))).toContain("answers only the workspace");
    expect(typeof await reader.measure("right")).toBe("number");
    impl.ctx.facets.delete("reader-probe");
  }));
});

describe("readGadgetStorage", () => {
  it("measures the gadget's storage, and the gadget comes back with its data", () =>
      withGadget(async impl => {
    let gadget = await gadgetOf(impl);
    expect(await gadget.add("first")).toStrictEqual(["first"]);
    expect(await gadget.add("second")).toStrictEqual(["first", "second"]);

    let measured = await impl.readGadgetStorage(GADGET_ID, "measure");
    expect(measured).toStrictEqual({ bytes: expect.any(Number), measuredAt: expect.any(Date) });
    expect(measured.bytes).toBeGreaterThan(0);
    expect(impl.storage.gadgetDataSizes.get(GADGET_ID)).toStrictEqual({
      gadgetId: GADGET_ID, ...measured,
    });

    // The stub held across the read was cut off by the pause; a new one runs the gadget.
    expect(await rejection(gadget.notes())).toContain("Paused while an admin takes a copy");
    let again = await gadgetOf(impl);
    expect(await again.whoami()).toBe("gadget");
    expect(await again.add("third")).toStrictEqual(["first", "second", "third"]);
  }));

  it("copies the tables and key-value storage as data.json holds them", () =>
      withGadget(async impl => {
    await (await gadgetOf(impl)).add("only");
    let file: GadgetDataFile = await impl.readGadgetStorage(GADGET_ID, "dump");
    expect(file).toStrictEqual({
      format: "cloudflare-os/gadget-data", version: 1, gadget: { id: GADGET_ID, name: "Notes" },
      exportedAt: expect.any(String), sizeBytes: expect.any(Number),
      sql: [{
        name: "notes",
        createSql: "CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT, raw BLOB)",
        rows: [{ id: 1, body: "only", raw: { $bytes: "AQID" } }],
      }],
      kv: [
        { key: "count", value: 1 },
        { key: "seen", value: { $map: [["only", { $date: "1970-01-01T00:00:00.000Z" }]] } },
      ],
    });
    expect(impl.storage.gadgetDataSizes.get(GADGET_ID).bytes).toBe(file.sizeBytes);
    expect(await (await gadgetOf(impl)).notes()).toStrictEqual(["only"]);
  }));

  it("leaves out an FTS5 table's shadow tables, which creating it makes again", () =>
      withGadget(async impl => {
    await (await gadgetOf(impl)).addSearch("hello world");
    let file: GadgetDataFile = await impl.readGadgetStorage(GADGET_ID, "dump");
    expect(file.sql).toStrictEqual([{
      name: "search", createSql: "CREATE VIRTUAL TABLE search USING fts5(body)",
      rows: [{ body: "hello world" }],
    }]);
  }));

  // SqlStorage reads an INTEGER as a JavaScript number, so one past 2^53 arrives rounded, as
  // data.json's documentation says.
  it("copies an integer past 2^53 as the number SqlStorage reads it as", () =>
      withGadget(async impl => {
    await (await gadgetOf(impl)).addBig();
    let file: GadgetDataFile = await impl.readGadgetStorage(GADGET_ID, "dump");
    expect(file.sql.find(table => table.name === "big")!.rows)
        .toStrictEqual([{ n: 9007199254740992 }]);
  }));

  it("copies a column named __proto__ from a real table", () => withGadget(async impl => {
    await (await gadgetOf(impl)).addOdd("kept");
    let file: GadgetDataFile = await impl.readGadgetStorage(GADGET_ID, "dump");
    let odd = file.sql.find(table => table.name === "odd")!;
    expect(odd.rows).toHaveLength(1);
    expect(Object.hasOwn(odd.rows[0]!, "__proto__")).toBe(true);
    expect(JSON.stringify(odd.rows)).toBe('[{"__proto__":"kept"}]');
  }));

  it("releases the lock when the abort that ends the read throws", () =>
      withGadget(async impl => {
    await (await gadgetOf(impl)).add("kept");
    let facets = impl.ctx.facets;
    let abort = facets.abort;
    // The abort that ends the read throws, as for a facet deleted while it was read.
    facets.abort = function(this: unknown, name: string, reason: unknown) {
      Reflect.apply(abort, facets, [name, reason]);
      if (String(reason).includes("copy is taken")) throw new Error("abort failed");
    };
    try {
      await expect(impl.readGadgetStorage(GADGET_ID, "measure")).rejects.toThrow("abort failed");
    } finally {
      facets.abort = abort;
    }
    // A later restore of the gadget proceeds, and so does the next read.
    let gadget = await gadgetOf(impl);
    expect(await gadget.notes()).toStrictEqual(["kept"]);
    expect((await impl.readGadgetStorage(GADGET_ID, "measure")).bytes).toBeGreaterThan(0);
  }));

  it("makes a connection opened during the read wait, then run the gadget's own class", () =>
      withGadget(async impl => {
    await (await gadgetOf(impl)).add("kept");
    let order: string[] = [];
    let read = impl.readGadgetStorage(GADGET_ID, "dump").then(() => order.push("read"));
    // The lock is taken before readGadgetStorage() first awaits.
    let connected = gadgetOf(impl).then(async gadget => {
      order.push("connected");
      return { whoami: await gadget.whoami(), notes: await gadget.notes() };
    });
    expect(await connected).toStrictEqual({ whoami: "gadget", notes: ["kept"] });
    await read;
    expect(order).toStrictEqual(["read", "connected"]);
  }));

  it("makes a persistent stub restored during the read wait, then reach the gadget", () =>
      withGadget(async impl => {
    await (await gadgetOf(impl)).add("kept");
    using callback = await (await gadgetOf(impl)).mintCallback();
    await impl.ctx.storage.put("callback", callback);

    let order: string[] = [];
    let read = impl.readGadgetStorage(GADGET_ID, "measure").then(() => order.push("read"));
    // Read back from storage, the stub restores through the Overseer's [restore]().
    using restored = await impl.ctx.storage.get("callback");
    let notes = restored.notes().then((value: string[]) => {
      order.push("restored");
      return value;
    });
    expect(await notes).toStrictEqual(["kept"]);
    await read;
    expect(order).toStrictEqual(["read", "restored"]);
  }));

  it("refuses data whose storage is larger than its limit without copying it, naming both",
      () => withGadget(async impl => {
    await (await gadgetOf(impl)).add("kept");
    let size = (await impl.readGadgetStorage(GADGET_ID, "measure")).bytes;
    for (let mode of ["dump", "dumpJson"]) {
      await expect(impl.readGadgetStorage(GADGET_ID, mode, { maxBytes: 100 })).rejects.toThrow(
          `The gadget's stored data is ${size} bytes, more than the 100 bytes a copy of its ` +
          "data may hold.");
    }
    // The gadget answers with its data, and the next read goes ahead.
    let gadget = await gadgetOf(impl);
    expect(await gadget.notes()).toStrictEqual(["kept"]);
    expect((await impl.readGadgetStorage(GADGET_ID, "dump")).sql[0].rows).toHaveLength(1);
  }));

  it("restores the gadget and releases the lock when the read fails", () =>
      withGadget(async impl => {
    let stub = await gadgetOf(impl);
    await stub.add("x");
    // A value JSON cannot hold, which the reader fails on as it encodes.
    await stub.addCycle();
    await expect(impl.readGadgetStorage(GADGET_ID, "dump")).rejects.toThrow("refers to itself");
    // Nothing is kept of a read that failed, and the gadget answers as before.
    expect(impl.storage.gadgetDataSizes.get(GADGET_ID)).toBeUndefined();
    let gadget = await gadgetOf(impl);
    expect(await gadget.whoami()).toBe("gadget");
    expect(await gadget.add("y")).toHaveLength(2);
    // And the next read goes ahead.
    expect((await impl.readGadgetStorage(GADGET_ID, "measure")).bytes).toBeGreaterThan(0);
  }));

  it("reads one gadget at a time, and lets a code update wait for the read", () =>
      withGadget(async impl => {
    await (await gadgetOf(impl)).add("kept");
    let first = impl.readGadgetStorage(GADGET_ID, "dump");
    let second = impl.readGadgetStorage(GADGET_ID, "measure");
    // A code update while the reader runs restarts the gadget once the read ends, not the reader.
    impl.bumpVersion([GADGET_ID]);
    let [dumped, measured] = await Promise.all([first, second]);
    expect(dumped.sql[0].rows).toHaveLength(1);
    expect(measured.bytes).toBeGreaterThan(0);
    expect(await (await gadgetOf(impl)).notes()).toStrictEqual(["kept"]);
  }));

  it("refuses a pending gadget and an id that names none, pausing nothing", () =>
      withGadget(async impl => {
    await expect(impl.readGadgetStorage(GADGET_ID, "measure"))
        .rejects.toThrow(`No permanent gadget has id ${GADGET_ID}.`);
    await expect(impl.readGadgetStorage(99, "measure"))
        .rejects.toThrow("No permanent gadget has id 99.");
    expect(impl.storage.gadgetDataSizes.get(GADGET_ID)).toBeUndefined();
  }, { pending: { chatId: 1 } }));

  it("forgets a gadget's measured size when the gadget is deleted", () =>
      withGadget(async impl => {
    await impl.readGadgetStorage(GADGET_ID, "measure");
    expect(impl.storage.gadgetDataSizes.get(GADGET_ID)).toBeDefined();
    await impl.removeWorkpiece(GADGET_ID);
    expect(impl.storage.gadgetDataSizes.get(GADGET_ID)).toBeUndefined();
  }));
});
