// Viewer sessions (docs/viewer-sessions.md): a gadget whose blueprint sets `viewerSessions` gets
// `openViewerSession(viewer)` called by the Workshop when someone connects, with who they are and
// the role their session holds, and the client gets the RpcTarget it returns instead of the facet
// stub. Only the Workshop may make that call: the facet stub refuses it, so a client cannot claim
// to be someone else. The session is counted and severed exactly as the facet stub is.
//
// Whether a gadget opts in is recorded with the release it runs (GadgetUpstream.viewerSessions;
// blueprints.test.ts covers the recording), so the records are seeded here directly.
//
// Runs against real Overseer and User DOs (the TEST_OVERSEER and TEST_USER bindings), opening the
// workspace through OverseerDurableObject.open() as live-calls.test.ts does, with a real gadget
// facet loaded from a real commit as gadget-restore.test.ts does. The BLUEPRINTS namespace, which
// the suites' Worker does not bind, holds the one blueprint the gadgets follow.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type {
  AiChatAuthorInfo, CollaboratorGrant, GadgetClient, GadgetViewer, Overseer,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";
import type { BlueprintKvRecord } from "../src/storage-schema/blueprints-kv.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];
type UserStub = DurableObjectStub<UserDurableObject>;

// A gadget that implements openViewerSession(): each session answers with the viewer it was
// opened for, so a test reads back exactly what the gadget received, holds a call open until the
// session dies, and counts its disposal.
const SERVER_JS = `
import { DurableObject, RpcTarget } from "cloudflare:workers";

export class Gadget extends DurableObject {
  closedSessions = 0;

  hello() {
    return "facet";
  }

  closed() {
    return this.closedSessions;
  }

  openViewerSession(viewer) {
    return new ViewerSession(this, viewer);
  }
}

class ViewerSession extends RpcTarget {
  #gadget;
  #viewer;
  constructor(gadget, viewer) {
    super();
    this.#gadget = gadget;
    this.#viewer = viewer;
  }
  viewer() {
    return this.#viewer;
  }
  hold() {
    return new Promise(() => {});
  }
  [Symbol.dispose]() {
    this.#gadget.closedSessions++;
  }
}
`;

// A gadget whose openViewerSession() returns nothing at all.
const BROKEN_SERVER_JS = `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  openViewerSession(viewer) {}
}
`;

// All three gadgets follow one blueprint, which as now published opts into viewer sessions. Gadget
// 100 runs a release of it recorded as opting in, and 102 a broken one recorded the same way.
// Gadget 101 runs the same code as 100, but from a release recorded without the flag: what the
// blueprint says now must not matter to it.
const VIEWER_GADGET = 100;
const PLAIN_GADGET = 101;
const BROKEN_GADGET = 102;
const BLUEPRINT = "viewer-sessions-blueprint";

const BLUEPRINT_RECORD: BlueprintKvRecord = {
  metadata: {
    title: "Swarm", description: "", author: {type: "user", id: "author@example.com", name: "Author"},
    created: new Date(0), version: 2, lastUpdated: new Date(0), bindings: {}, viewerSessions: true,
  },
};
const BLUEPRINTS = {
  get: async (key: string) => key === BLUEPRINT ? JSON.stringify(BLUEPRINT_RECORD) : null,
} as unknown as KVNamespace;

const person = (name: string): AiChatAuthorInfo =>
  ({type: "user", id: `${name.trim().toLowerCase() || "nameless"}-${crypto.randomUUID()}@example.com`, name});

async function signedUp(profile: AiChatAuthorInfo): Promise<UserStub> {
  let user = env.TEST_USER.getByName(profile.id);
  await runInDurableObject(user, (_instance, ctx) => {
    let storage = makeUserStorage(ctx.storage);
    storage.profile.put(profile);
    storage.created.put(true);
  });
  return user;
}

function withImpl<T>(workspace: DurableObjectStub<OverseerDurableObject>, fn: (impl: Impl) => Promise<T>) {
  return runInDurableObject(workspace, async (instance: OverseerDurableObject) => fn(instance["impl"]));
}

// An owner and their workspace, holding gadgets 100, 101 and 102.
async function setup() {
  let owner = person("Owner");
  let ownerUser = await signedUp(owner);
  let workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  await ownerUser.newWorkspace(workspace.id.toString(), "Swarm");
  await withImpl(workspace, async impl => {
    impl.env = {...impl.env, BLUEPRINTS};
    impl.ensureAmbientCapsules = async () => {};
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.title.put("Swarm");
    impl.storage.ownerId.put(ownerUser.id.toString());
    impl.ownerId = ownerUser.id.toString();
    let commit = (serverJs: string) => impl.gitCache.writeFilesAsCommit(new Map([["server.js", serverJs]]), {
      parents: [],
      author: {name: "Owner", email: "owner@example.com"},
      message: "Instantiate blueprint: Swarm",
      timestamp: new Date(1700000000_000),
    });
    let gadgets = [
      [VIEWER_GADGET, await commit(SERVER_JS), true],
      [PLAIN_GADGET, await commit(SERVER_JS), false],
      [BROKEN_GADGET, await commit(BROKEN_SERVER_JS), true],
    ] as const;
    for (let [id, commitId, viewerSessions] of gadgets) {
      impl.storage.gadgets.put({type: "gadget", id, title: `Gadget ${id}`, created: new Date(0),
        bindingName: `G${id}`, bindings: {}, commitId,
        upstream: {blueprintId: BLUEPRINT, commitId, ...(viewerSessions ? {viewerSessions} : {})}});
    }
  });
  return {owner, ownerUser, workspace};
}
type Fixture = Awaited<ReturnType<typeof setup>>;

// Opens the workspace as `user` through the real open() and runs `fn` on the session.
function asUser<T>(fixture: Fixture, user: UserStub, profile: AiChatAuthorInfo,
    fn: (session: Overseer, impl: Impl) => Promise<T>): Promise<T> {
  return runInDurableObject(fixture.workspace, async (instance: OverseerDurableObject) => {
    let session = await instance.open(user.id.toString(), profile.id, new NativeRpcStub(() => {}));
    try {
      return await fn(session, instance["impl"]);
    } finally {
      (session as unknown as Disposable)[Symbol.dispose]();
    }
  });
}

const asOwner = <T>(fixture: Fixture, fn: (session: Overseer, impl: Impl) => Promise<T>) =>
  asUser(fixture, fixture.ownerUser, fixture.owner, fn);

// A collaborator, signed up as `profile` and given `grants`.
async function collaborator(fixture: Fixture, profile: AiChatAuthorInfo, ...grants: CollaboratorGrant[]) {
  let user = await signedUp(profile);
  for (let grant of grants) {
    await asOwner(fixture, session => session.addCollaborator(profile.id, grant));
  }
  return {profile, user};
}

const gadget = (session: Overseer, id: number) =>
  session.getGadget(id) as unknown as Promise<GadgetClient>;

// What a gadget's viewer session answers with: the viewer it was opened for.
type ViewerSession = { viewer(): Promise<GadgetViewer>, hold(): Promise<never> } & Disposable;
type Facet = { hello(): Promise<string>, openViewerSession(viewer: GadgetViewer): Promise<unknown> };

const connect = async <T>(session: Overseer, id: number) =>
  (await gadget(session, id)).connectToGadget() as Promise<T>;

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

function dispose(value: unknown): void {
  (value as Disposable)[Symbol.dispose]();
}

// Replaces the restart that severs sessions with a recorder of its reasons: a real one would abort
// the workspace, and the test running inside it.
function recordRestarts(impl: Impl): string[] {
  let restarts: string[] = [];
  impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
  return restarts;
}

// A connection that collaborators are verified against, so binding it widens a gadget's scope.
function seedGatekeeper(impl: Impl, id: number): void {
  impl.storage.gatekeepers.put({
    id, resourceTitle: `Connection ${id}`, class: {} as never,
    creationSpec: {type: "gatekeeper", vendorId: "testvendor",
      resourceUrl: `https://example.com/${id}`, typeUrlPattern: "https://*"},
  });
}

// Opens the workspace as `user` from outside it, as a browser does, through a fresh stub (one held
// across a restart is broken): the restart that severs sessions aborts the workspace, and with it
// any code running inside.
function openOutside(fixture: Fixture, user: UserStub, profile: AiChatAuthorInfo): Promise<Overseer> {
  return env.TEST_OVERSEER.get(fixture.workspace.id).open(
      user.id.toString(), profile.id, new NativeRpcStub(() => {})) as unknown as Promise<Overseer>;
}

// Waits for a viewer session to be severed by the restart that revokes access, which lands once
// the response to the change has had time to reach whoever made it: `held`, the rejection of a
// call it held open, is the restart's, and its next call fails too.
async function severed(viewerSession: ViewerSession, held: Promise<string>): Promise<void> {
  expect(await held).toMatch(/Gadget restarted to revoke access/);
  await rejection(viewerSession.viewer());
}

describe("viewer sessions", () => {
  it("owner connecting gets role owner", async () => {
    let fixture = await setup();
    let viewer = await asOwner(fixture, async session =>
        (await connect<ViewerSession>(session, VIEWER_GADGET)).viewer());
    expect(viewer).toEqual({profileId: fixture.owner.id, name: "Owner", role: "owner"});
  });

  it("build collaborator gets role build", async () => {
    let fixture = await setup();
    let builder = await collaborator(fixture, person("Builder"), "workspace");
    let viewer = await asUser(fixture, builder.user, builder.profile, async session =>
        (await connect<ViewerSession>(session, VIEWER_GADGET)).viewer());
    expect(viewer).toEqual({profileId: builder.profile.id, name: "Builder", role: "build"});
  });

  it("use collaborator gets role use", async () => {
    let fixture = await setup();
    // A blank display name falls back to the local part of the profile id.
    let user = await collaborator(fixture, person("  "), {gadgetId: VIEWER_GADGET});
    let viewer = await asUser(fixture, user.user, user.profile, async session =>
        (await connect<ViewerSession>(session, VIEWER_GADGET)).viewer());
    expect(viewer).toEqual(
        {profileId: user.profile.id, name: user.profile.id.split("@")[0], role: "use"});
    expect(viewer.name).toMatch(/^nameless-/);
  });

  it("client cannot call openViewerSession on the facet", async () => {
    let fixture = await setup();
    let user = await collaborator(fixture, person("Viewer"), {gadgetId: PLAIN_GADGET});
    let forged: GadgetViewer = {profileId: fixture.owner.id, name: "Owner", role: "owner"};
    await asUser(fixture, user.user, user.profile, async session => {
      // The gadget implements the method, so only the Workshop's refusal stands in the way.
      let facet = await connect<Facet>(session, PLAIN_GADGET);
      expect(await rejection(facet.openViewerSession(forged))).toMatch(/openViewerSession/);
      expect(await facet.hello()).toBe("facet");
    });
    // The owner's facet, and the stub binding loopbacks hand agents and other gadgets, are the
    // same stub, so they refuse it too.
    await asOwner(fixture, async (session, impl) => {
      let facet = await connect<Facet>(session, PLAIN_GADGET);
      expect(await rejection(facet.openViewerSession(forged))).toMatch(/openViewerSession/);
      let internal = await impl.getGadgetFacet(PLAIN_GADGET) as unknown as Facet;
      expect(await rejection(internal.openViewerSession(forged))).toMatch(/openViewerSession/);
    });
  });

  it("gadget without viewerSessions keeps the facet stub", async () => {
    // Gadget 101's release was recorded without the flag, though its blueprint now has it.
    let fixture = await setup();
    let user = await collaborator(fixture, person("Viewer"), {gadgetId: PLAIN_GADGET});
    await asUser(fixture, user.user, user.profile, async session => {
      expect(await (await connect<Facet>(session, PLAIN_GADGET)).hello()).toBe("facet");
    });
    await asOwner(fixture, async session => {
      expect(await (await connect<Facet>(session, PLAIN_GADGET)).hello()).toBe("facet");
    });
  });

  it("disposing a viewer session disposes the gadget's target", async () => {
    let fixture = await setup();
    await asOwner(fixture, async (session, impl) => {
      let viewerSession = await connect<ViewerSession>(session, VIEWER_GADGET);
      await viewerSession.viewer();
      let facet = await impl.getGadgetFacet(VIEWER_GADGET) as unknown as { closed(): Promise<number> };
      expect(await facet.closed()).toBe(0);
      viewerSession[Symbol.dispose]();
      await vi.waitFor(async () => expect(await facet.closed()).toBe(1));
    });
  });

  it("a retained viewer session counts as a session holding its gadget until disposed", async () => {
    let fixture = await setup();
    let user = await collaborator(fixture, person("Viewer"), {gadgetId: VIEWER_GADGET});
    await runInDurableObject(fixture.workspace, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      let restarts = recordRestarts(impl);
      seedGatekeeper(impl, 1);
      let session = await instance.open(user.user.id.toString(), user.profile.id, new NativeRpcStub(() => {}));
      let client = await gadget(session, VIEWER_GADGET);
      let viewerSession = await client.connectToGadget() as ViewerSession;

      // With every wrapper disposed, the retained viewer session must keep counting on its own, or
      // a widening would find no session to sever while it kept reading gadget state.
      dispose(session);
      dispose(client);
      impl.bindWorkpiece(VIEWER_GADGET, "DB", 1);
      expect(restarts).toHaveLength(1);

      // Once it too is gone, a widening finds nothing to sever. (Stub disposal reaches the wrapped
      // target's disposer asynchronously, so let it settle.)
      viewerSession[Symbol.dispose]();
      await new Promise(resolve => setTimeout(resolve, 0));
      seedGatekeeper(impl, 2);
      impl.bindWorkpiece(VIEWER_GADGET, "DB2", 2);
      expect(restarts).toHaveLength(1);
    });
  });

  it("a gadget that returns no session is refused, and leaves nothing counted", async () => {
    let fixture = await setup();
    let user = await collaborator(fixture, person("Viewer"), {gadgetId: BROKEN_GADGET});
    await runInDurableObject(fixture.workspace, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      let restarts = recordRestarts(impl);
      seedGatekeeper(impl, 1);
      let session = await instance.open(user.user.id.toString(), user.profile.id, new NativeRpcStub(() => {}));
      let client = await gadget(session, BROKEN_GADGET);
      expect(await rejection(client.connectToGadget()))
          .toMatch(/openViewerSession\(\) must return an RpcTarget, not undefined/);

      // The failed connect released what it counted, so with the session and the gadget's
      // capability disposed, a widening finds nothing to sever.
      dispose(session);
      dispose(client);
      impl.bindWorkpiece(BROKEN_GADGET, "DB", 1);
      expect(restarts).toEqual([]);
    });
  });

  it("narrowing a collaborator severs their viewer session", async () => {
    let fixture = await setup();
    let user = await collaborator(fixture, person("Viewer"),
        {gadgetId: VIEWER_GADGET}, {gadgetId: PLAIN_GADGET});
    let session = await openOutside(fixture, user.user, user.profile);
    let viewerSession = await connect<ViewerSession>(session, VIEWER_GADGET);
    expect(await viewerSession.viewer()).toMatchObject({role: "use"});
    let held = rejection(viewerSession.hold());

    let owner = await openOutside(fixture, fixture.ownerUser, fixture.owner);
    await owner.removeCollaborator(user.profile.id, [], VIEWER_GADGET);
    await severed(viewerSession, held);
  });

  it("narrowing a build collaborator to use severs their build session; a new one is use", async () => {
    let fixture = await setup();
    let sharer = await collaborator(fixture, person("Sharer"), "workspace");
    let user = await collaborator(fixture, person("Viewer"), {gadgetId: VIEWER_GADGET});
    // The sharer's grant of the whole workspace makes the viewer a build collaborator.
    let bySharer = await openOutside(fixture, sharer.user, sharer.profile);
    await bySharer.addCollaborator(user.profile.id, "workspace");
    let viewerSession = await connect<ViewerSession>(
        await openOutside(fixture, user.user, user.profile), VIEWER_GADGET);
    expect(await viewerSession.viewer()).toMatchObject({role: "build"});
    let held = rejection(viewerSession.hold());

    // Withdrawing it leaves the owner's grant of the one gadget. The session that said "build"
    // must not outlive that...
    await bySharer.removeCollaborator(user.profile.id, []);
    await severed(viewerSession, held);

    // ...and reconnecting opens a session with the role they hold now.
    let reopened = await openOutside(fixture, user.user, user.profile);
    expect(await (await connect<ViewerSession>(reopened, VIEWER_GADGET)).viewer())
        .toEqual({profileId: user.profile.id, name: "Viewer", role: "use"});
  });
});
