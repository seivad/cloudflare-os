import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, getAdminAccessErrorCode,
  type AdminApi, type AdminWorkspaceView, type GadgetClient, type Overseer, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder,
} from "../src/rpc-client.js";

// An admin's read of a gadget's stored data, end to end: measureGadget() on a deployment whose cap
// and level are "content", the gadget paused while the Workshop's reader takes its place, the
// connections made meanwhile, and the refusal below "content". The level is deployment-wide, so
// this file owns its harness and its cases run in order.

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

it("refuses a pending gadget's read and goes on reading the next", async () => {
  await withNotesGadget(["kept"], async ({ ws, gadget, gadgetId, workspaceId }) => {
    const chatId = await ws.newChat("Draft", null);
    using pending = await ws.createGadget("Draft gadget", chatId, "DRAFT");
    const pendingId = await pending.getId();

    using view = await inspect(workspaceId);
    await expect(view.measureGadget(pendingId))
        .rejects.toThrow(`No permanent gadget has id ${pendingId}.`);
    await expect(view.measureGadget(9999)).rejects.toThrow("No permanent gadget has id 9999.");
    expect((await view.measureGadget(gadgetId)).bytes).toBeGreaterThan(0);
    expect(await notesOf(gadget)).toEqual({ bodies: ["kept"], count: 1 });
  });
});

it("refuses measureGadget below content, recording the refusal and reading nothing", async () => {
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
      expect(await view.listGadgetDataSizes()).toEqual([]);
      // The gadget was never paused.
      using facet = await gadget.connectToGadget() as NotesGadget;
      expect(await facet.notes()).toEqual({ bodies: ["kept"], count: 1 });
    } finally {
      await admin.setAdminWorkspaceAccess("content");
    }
  });
});
