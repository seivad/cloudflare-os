import { inflateRawSync } from "node:zlib";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, getAdminAccessErrorCode,
  type AdminApi, type AdminWorkspaceView, type GadgetClient, type Overseer, type TreeNode,
  type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder,
} from "../src/rpc-client.js";

// An admin's read of a gadget's stored data and copy of the gadget, end to end: measureGadget()
// and exportGadget() on a deployment whose cap and level are "content", the gadget paused while
// the Workshop's reader takes its place, the connections made meanwhile, a copy of the code that
// another account imports, and the refusals below "content". The level is deployment-wide, so this
// file owns its harness and its cases run in order.

const REASON = "Reviewing the notes gadget";
const network = new NetworkInterceptor();
const fileScope = new DisposableStack();
let harness: Harness;
let admin: RpcStub<AdminApi>;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    enableGadgetExecution: true,
    patchWorkshop: config => {
      config.vars = { ...config.vars, ADMIN_WORKSPACE_ACCESS_MAX: "content" };
    },
  });
  const api = fileScope.use(await signUp(fileScope.use(connect(harness.url)), ADMIN_USERNAME));
  const stub = await api.getAdminApi();
  if (stub === null) throw new Error("The admin API was unavailable");
  admin = fileScope.use(stub);
  await admin.setAdminWorkspaceAccess("content");
});

afterAll(async () => {
  try {
    fileScope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

// A gadget that keeps notes in SQL and a counter in its key-value storage.
const SERVER_JS = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  add(body) {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, body)");
    this.ctx.storage.sql.exec("INSERT INTO notes(body) VALUES (?)", body);
    this.ctx.storage.kv.put("count", (this.ctx.storage.kv.get("count") ?? 0) + 1);
    return this.notes();
  }
  notes() {
    let notes = this.ctx.storage.sql.exec("SELECT body FROM notes ORDER BY id").toArray();
    return { bodies: notes.map(row => row.body), count: this.ctx.storage.kv.get("count") };
  }
}
`;

type Notes = { bodies: string[]; count: number };
type NotesGadget = RpcStub<{ add(body: string): Notes; notes(): Notes }>;

const files = (gadgetId: WorkpieceId, text?: string): CodeContent =>
  new Map([[gadgetId, new Map(text === undefined ? [] : [["server.js", text]])]]);

type Owner = {
  ws: RpcStub<Overseer>;
  gadget: RpcStub<GadgetClient>;
  gadgetId: WorkpieceId;
  workspaceId: string;
};

/** Sign up an owner whose workspace has the notes gadget merged, holding `notes` already. */
async function withNotesGadget<T>(notes: string[], fn: (owner: Owner) => Promise<T>): Promise<T> {
  const [username] = nextUsernames("exportowner");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username!);
  using ws = await api.newWorkspace();
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;
  using gadget = await ws.createGadget("Notes", undefined, "NOTES");
  const gadgetId = await gadget.getId();
  const empty = await waitFor(`the head of gadget ${gadgetId}`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined ? summary.commitId : null;
  });
  const seed = await ws.newChat("Seed", null);
  await ws.submitCodeChange(seed, {
    generation: 0, revision: 0, clientId: "seed", seq: 1, pins: [{ gadgetId, baseCommit: empty }],
    change: diffFiles(files(gadgetId), files(gadgetId, SERVER_JS)),
  });
  expect(await ws.mergeChanges(seed)).toEqual({ outcome: "merged" });
  {
    using facet = await gadget.connectToGadget() as NotesGadget;
    for (const body of notes) await facet.add(body);
  }
  const workspaceId = (await ws.getMetadata()).id;
  return await fn({ ws, gadget, gadgetId, workspaceId });
}

/** The gadget's notes through a fresh connection, reconnecting when a read paused the gadget
 * under the one it had: a connection opened before a read is cut off by it, and reconnects once
 * per read. Any other failure, a connection that reached the reader among them, is thrown. */
async function notesOf(gadget: RpcStub<GadgetClient>, reads = 1): Promise<Notes> {
  for (let attempt = 0; ; attempt++) {
    // Disposed by hand: as this suite is compiled, a `using` here rethrew an earlier attempt's
    // error when a later attempt disposed its stub.
    const facet = await gadget.connectToGadget() as NotesGadget;
    try {
      return await facet.notes();
    } catch (error) {
      if (attempt >= reads || !String(error).includes("Paused while an admin takes a copy")) {
        throw error;
      }
    } finally {
      facet[Symbol.dispose]();
    }
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return getAdminAccessErrorCode(error) ?? `uncoded: ${String(error)}`;
  }
  throw new Error("Expected a refusal.");
}

function inspect(workspaceId: string): Promise<RpcStub<AdminWorkspaceView>> {
  return admin.inspectWorkspace(workspaceId, REASON);
}

const bytesOf = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer());

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Response(bytes).body!;

/** The container version in a `.gadget` archive's header: 2 for one whose content is a release. */
const archiveVersion = (archive: Uint8Array) =>
  new DataView(archive.buffer, archive.byteOffset, archive.byteLength).getUint32(8);

/** A ZIP's entries by name, as bytes, read from its central directory and inflated. */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const entries = new Map<string, Uint8Array>();
  let at = view.getUint32(end + 16, true);
  for (let i = view.getUint16(end + 10, true); i > 0; i--) {
    const packedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.set(
        new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
        new Uint8Array(inflateRawSync(bytes.subarray(dataAt, dataAt + packedSize))));
    at += 46 + nameLength;
  }
  return entries;
}

function treePaths(nodes: TreeNode[], prefix = ""): string[] {
  return nodes.flatMap(node => {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    return node.kind === "dir" ? treePaths(node.children, path) : [path];
  });
}

/** The files of the one gadget a workspace made from a blueprint holds, at its head. */
async function installedCode(ws: RpcStub<Overseer>): Promise<Record<string, string>> {
  const { defaultGadgetId } = await ws.getMetadata();
  if (defaultGadgetId === undefined) throw new Error("The workspace has no default gadget");
  const workpieces = new WorkpieceRecorder();
  using stub = stubFor(workpieces);
  using _subscription = await ws.subscribeToWorkpieces(stub);
  await workpieces.loaded;
  const summary = workpieces.summaries.get(defaultGadgetId);
  if (summary?.type !== "gadget" || summary.commitId === undefined) {
    throw new Error(`Gadget ${defaultGadgetId} has no committed head`);
  }
  const paths = treePaths(await ws.listTree(summary.commitId));
  const code: Record<string, string> = {};
  for (const [path, file] of await ws.readFilesAtCommit(summary.commitId, paths)) {
    if (file.kind !== "text") throw new Error(`${path} is ${file.kind}`);
    code[path] = file.text;
  }
  return code;
}

/** Import `archive` as a new account and make a workspace of it, returning its gadget's files and
 * the blueprint's metadata. */
async function importAndInstall(archive: Uint8Array) {
  const [username] = nextUsernames("exportimporter");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username!);
  const blueprintId = await api.importBlueprint(streamOf(archive));
  const metadata = (await publicApi.getBlueprint(blueprintId))?.metadata;
  using ws = await api.newWorkspaceFromBlueprint(blueprintId, {});
  return { metadata, code: await installedCode(ws) };
}

it("measures a gadget's stored data, and the gadget goes on with its data", async () => {
  await withNotesGadget(["first", "second"], async ({ gadget, gadgetId, workspaceId }) => {
    using view = await inspect(workspaceId);
    expect(await view.listGadgetDataSizes()).toEqual([]);

    const measured = await view.measureGadget(gadgetId);
    expect(measured.bytes).toBeGreaterThan(0);
    expect(measured.measuredAt).toBeInstanceOf(Date);
    expect(await view.listGadgetDataSizes()).toEqual([{ gadgetId, ...measured }]);

    expect(await notesOf(gadget)).toEqual({ bodies: ["first", "second"], count: 2 });
    using facet = await gadget.connectToGadget() as NotesGadget;
    expect(await facet.add("third")).toEqual({ bodies: ["first", "second", "third"], count: 3 });

    const { records } = await admin.listAdminAudit({ kind: "workspace", limit: 2 });
    expect(records.map(record => [record.method, record.access, record.refused])).toEqual([
      ["listGadgetDataSizes", "content", undefined],
      ["measureGadget", "content", undefined],
    ]);
  });
});

it("copies a gadget's code as a blueprint archive another account imports and installs",
    async () => {
  await withNotesGadget(["kept"], async ({ gadget, gadgetId, workspaceId }) => {
    using view = await inspect(workspaceId);
    using connected = await gadget.connectToGadget() as NotesGadget;
    expect(await connected.notes()).toEqual({ bodies: ["kept"], count: 1 });
    const archive = await bytesOf(await view.exportGadget(gadgetId, "code"));
    expect(archiveVersion(archive)).toBe(2);

    const { metadata, code } = await importAndInstall(archive);
    expect(metadata).toMatchObject({ title: "Notes", description: "", version: 1, bindings: {} });
    expect(code).toEqual({ "server.js": SERVER_JS });

    // Code alone: the gadget was never paused, so the connection made before the copy goes on.
    expect(await connected.notes()).toEqual({ bodies: ["kept"], count: 1 });
    expect(await view.listGadgetDataSizes()).toEqual([]);
    const [record] = (await admin.listAdminAudit({ kind: "workspace", limit: 2 })).records.slice(1);
    expect(record).toMatchObject({
      kind: "workspace", workspaceId, method: "exportGadget", args: { gadgetId, mode: "code" },
      access: "content",
    });
    expect(record).not.toHaveProperty("refused");
  });
});

it("copies everything: the code archive, the gadget's data.json and a README", async () => {
  await withNotesGadget(["first", "second"], async ({ gadget, gadgetId, workspaceId }) => {
    using view = await inspect(workspaceId);
    const entries = unzip(await bytesOf(await view.exportGadget(gadgetId, "everything")));
    expect([...entries.keys()]).toEqual(["notes.gadget", "notes.data.json", "README.md"]);

    const data = JSON.parse(new TextDecoder().decode(entries.get("notes.data.json")));
    expect(data).toEqual({
      format: "cloudflare-os/gadget-data",
      version: 1,
      gadget: { id: gadgetId, name: "Notes" },
      exportedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      sizeBytes: expect.any(Number),
      sql: [{
        name: "notes",
        createSql: "CREATE TABLE notes(id INTEGER PRIMARY KEY, body)",
        rows: [{ id: 1, body: "first" }, { id: 2, body: "second" }],
      }],
      kv: [{ key: "count", value: 2 }],
    });
    expect(await view.listGadgetDataSizes())
        .toEqual([{ gadgetId, bytes: data.sizeBytes, measuredAt: expect.any(Date) }]);
    expect(new TextDecoder().decode(entries.get("README.md"))).toContain("**Import blueprint**");

    // The archive inside is the code copy, which imports as one.
    const archive = entries.get("notes.gadget")!;
    expect(archiveVersion(archive)).toBe(2);
    expect((await importAndInstall(archive)).code).toEqual({ "server.js": SERVER_JS });

    // The gadget goes on with its data.
    expect(await notesOf(gadget)).toEqual({ bodies: ["first", "second"], count: 2 });
    const { records } = await admin.listAdminAudit({ kind: "workspace", limit: 2 });
    expect(records.map(record => [record.method, record.args, record.access])).toEqual([
      ["listGadgetDataSizes", {}, "content"],
      ["exportGadget", { gadgetId, mode: "everything" }, "content"],
    ]);
  });
});

// Reads take about a millisecond, so connections mostly land between them: this checks end to end
// that connections interleaved with reads only ever see the gadget, cut off at most once per read.
// That a connection landing during a read waits for it is proven deterministically by the
// backend's gadget-storage-reader.test.ts.
it("lets the owner's and a collaborator's connections interleaved with reads see only the gadget",
    async () => {
  await withNotesGadget(["kept"], async ({ ws, gadget, gadgetId, workspaceId }) => {
    const [viewer] = nextUsernames("exportviewer");
    using viewerPublic = connect(harness.url);
    using viewerApi = await signUp(viewerPublic, viewer!);
    if (!await ws.addCollaborator(viewer!, { gadgetId })) {
      throw new Error(`Failed to share with ${viewer}`);
    }
    using viewerWs = await viewerApi.openWorkspace(workspaceId);
    using viewerGadget = await viewerWs.getGadget(gadgetId);

    using view = await inspect(workspaceId);
    // Reads and connections interleaved, so connections land before, during and after reads.
    // Without the lock, one landing during a read would reach the reader, which answers no
    // one but the Overseer; with it, every one gets the gadget with its data.
    const ROUNDS = 4;
    const connections: Promise<Notes>[] = [];
    const reads: Promise<unknown>[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      reads.push(view.measureGadget(gadgetId));
      for (const client of [gadget, viewerGadget]) {
        connections.push(notesOf(client, ROUNDS));
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    const settled = await Promise.allSettled([...reads, ...connections]);
    expect(settled.filter(result => result.status === "rejected")).toEqual([]);
    for (const result of settled.slice(ROUNDS)) {
      expect(result).toEqual({ status: "fulfilled", value: { bodies: ["kept"], count: 1 } });
    }
    expect(await notesOf(viewerGadget)).toEqual({ bodies: ["kept"], count: 1 });
  });
});

it("refuses a pending gadget's read and copy, and goes on reading the next", async () => {
  await withNotesGadget(["kept"], async ({ ws, gadget, gadgetId, workspaceId }) => {
    const chatId = await ws.newChat("Draft", null);
    using pending = await ws.createGadget("Draft gadget", chatId, "DRAFT");
    const pendingId = await pending.getId();

    using view = await inspect(workspaceId);
    await expect(view.measureGadget(pendingId))
        .rejects.toThrow(`No permanent gadget has id ${pendingId}.`);
    await expect(view.measureGadget(9999)).rejects.toThrow("No permanent gadget has id 9999.");
    await expect(view.exportGadget(pendingId, "code"))
        .rejects.toThrow(`No gadget with committed code has id ${pendingId}.`);
    await expect(view.exportGadget(pendingId, "everything"))
        .rejects.toThrow(`No gadget with committed code has id ${pendingId}.`);
    expect((await view.measureGadget(gadgetId)).bytes).toBeGreaterThan(0);
    expect(await notesOf(gadget)).toEqual({ bodies: ["kept"], count: 1 });
  });
});

it("refuses measureGadget and exportGadget below content, recording each refusal and reading " +
    "nothing", async () => {
  await withNotesGadget(["kept"], async ({ gadget, gadgetId, workspaceId }) => {
    using view = await inspect(workspaceId);
    await admin.setAdminWorkspaceAccess("metadata");
    try {
      expect(await codeOf(view.measureGadget(gadgetId)))
          .toBe(ADMIN_ACCESS_ERROR_CODES.accessInsufficient);
      const [record] = (await admin.listAdminAudit({ kind: "workspace", limit: 1 })).records;
      expect(record).toMatchObject({
        kind: "workspace", workspaceId, admin: ADMIN_USERNAME, method: "measureGadget",
        args: { gadgetId }, reason: REASON, access: "metadata",
        refused: ADMIN_ACCESS_ERROR_CODES.accessInsufficient,
      });
      expect(await codeOf(view.exportGadget(gadgetId, "everything")))
          .toBe(ADMIN_ACCESS_ERROR_CODES.accessInsufficient);
      const [exportRecord] = (await admin.listAdminAudit({ kind: "workspace", limit: 1 })).records;
      expect(exportRecord).toMatchObject({
        method: "exportGadget", args: { gadgetId, mode: "everything" }, access: "metadata",
        refused: ADMIN_ACCESS_ERROR_CODES.accessInsufficient,
      });
      expect(await view.listGadgetDataSizes()).toEqual([]);
      // The gadget was never paused.
      using facet = await gadget.connectToGadget() as NotesGadget;
      expect(await facet.notes()).toEqual({ bodies: ["kept"], count: 1 });
    } finally {
      await admin.setAdminWorkspaceAccess("content");
    }
  });
});
