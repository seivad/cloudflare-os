// Sharing a workspace with someone lists it in their account at once, marked new with who shared
// it, and tells their open tabs, before they ever open it (Overseer.announceShare() ->
// UserDurableObject.recordSharedWorkspaceGrant()). Their first open clears the mark and does the
// first-admission work as before; revocation removes the listing with its notice.
//
// Runs against real Overseer and User DOs (the TEST_OVERSEER and TEST_USER bindings), opening the
// workspace through OverseerDurableObject.open(). scheduleAccessRestart is replaced with a no-op: a
// real ctx.abort() would kill the test DO.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type {
  AiChatAuthorInfo, CollaboratorGrant, NotificationSubscriber, Overseer, UserNotification,
  WorkspaceMetadataWithTimestamps,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";
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

const person = (name: string): AiChatAuthorInfo =>
  ({type: "user", id: `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`, name});

// A User DO for an account that has signed in.
async function signedUp(profile: AiChatAuthorInfo): Promise<UserStub> {
  let user = env.TEST_USER.getByName(profile.id);
  await runInDurableObject(user, (_instance, ctx) => {
    let storage = makeUserStorage(ctx.storage);
    storage.profile.put(profile);
    storage.created.put(true);
  });
  return user;
}

// An owner and their workspace "Budget", with one chat and two shareable gadgets (100 and 101).
async function setup() {
  let owner = person("Owner");
  let ownerUser = await signedUp(owner);
  let workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  let workspaceId = workspace.id.toString();
  await ownerUser.newWorkspace(workspaceId, "Budget");
  await withImpl(workspace, async impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.title.put("Budget");
    impl.storage.ownerId.put(ownerUser.id.toString());
    impl.ownerId = ownerUser.id.toString();
    impl.storage.chatMeta.put({id: 1, title: "Demo", started: new Date(), lastActive: new Date()});
    for (let id of [100, 101]) {
      impl.storage.gadgets.put({type: "gadget", id, title: `Gadget ${id}`, created: new Date(0),
        bindingName: `G${id}`, bindings: {}});
    }
  });
  return {owner, ownerUser, workspace, workspaceId};
}
type Fixture = Awaited<ReturnType<typeof setup>>;

function withImpl<T>(workspace: DurableObjectStub<OverseerDurableObject>, fn: (impl: Impl) => Promise<T>) {
  return runInDurableObject(workspace, async (instance: OverseerDurableObject) => {
    let impl = instance["impl"];
    impl.scheduleAccessRestart = async () => {};
    return fn(impl);
  });
}

// Opens the workspace as `user` through the real open(), runs `fn` on the session, then closes it.
function asUser<T>(fixture: Fixture, user: UserStub, profile: AiChatAuthorInfo,
    fn: (session: Overseer, impl: Impl) => Promise<T>): Promise<T> {
  return runInDurableObject(fixture.workspace, async (instance: OverseerDurableObject) => {
    let impl = instance["impl"];
    impl.scheduleAccessRestart = async () => {};
    // Ambient capsules need the deployment's admin config, which this pool doesn't bind.
    impl.ensureAmbientCapsules = async () => {};
    let session = await instance.open(user.id.toString(), profile.id, new NativeRpcStub(() => {}));
    try {
      return await fn(session, impl);
    } finally {
      (session as unknown as Disposable)[Symbol.dispose]();
    }
  });
}

const share = (fixture: Fixture, username: string, grant: CollaboratorGrant, note?: string) =>
  asUser(fixture, fixture.ownerUser, fixture.owner, session => session.addCollaborator(username, grant, note));

// Writes a visible message to chat 1 and fans it out to everyone the workspace may tell.
const appendMessage = (fixture: Fixture, sequence: number) => withImpl(fixture.workspace, async impl => {
  impl.storage.chats.put({chatId: 1, sequence, timestamp: new Date(1_000 + sequence),
    author: {type: "agent", id: "test", name: "Test"}, type: "message", message: "Hello"});
  impl.storage.nextChatSequences.put({...impl.storage.nextChatSequences.get(1), chatId: 1, nextSequence: sequence + 1});
  await impl.deliverDirtyChats();
});

const listing = async (user: UserStub, workspaceId: string) =>
  (await user.listWorkspaces()).find(workspace => workspace.id === workspaceId);

const cursor = (user: UserStub, workspaceId: string) => runInDurableObject(user, (_instance, ctx) =>
  makeUserStorage(ctx.storage).chatReadCursors.get(`${workspaceId}:1`));

// RPC exposes prototype methods only, as the browser's NotificationSubscriberImpl defines them.
class Subscriber extends RpcTarget {
  shared: WorkspaceMetadataWithTimestamps[] = [];
  async notify(_notification: UserNotification): Promise<void> {}
  async workspaceShared(workspace: WorkspaceMetadataWithTimestamps): Promise<void> {
    this.shared.push(workspace);
  }
}

describe("sharing a workspace lists it for the collaborator before they open it", () => {
  it("lists it marked new, with the sharer's note, and tells their open tabs", async () => {
    let fixture = await setup();
    let reader = person("Reader");
    let readerUser = await signedUp(reader);
    let tab = new Subscriber();
    let subscription = await runInDurableObject(readerUser, user =>
      user.subscribeToNotifications(new RpcStub(tab) as unknown as RpcStub<NotificationSubscriber>));

    await share(fixture, reader.id, "workspace", "Numbers for Q3");

    let expected = {
      id: fixture.workspaceId, title: "Budget", owner: fixture.owner, role: "build",
      newShare: {sharedBy: fixture.owner, note: "Numbers for Q3"},
    };
    await vi.waitFor(async () => expect(await listing(readerUser, fixture.workspaceId)).toMatchObject(expected));
    await vi.waitFor(() => expect(tab.shared).toEqual([expect.objectContaining(expected)]));
    subscription[Symbol.dispose]();
    // Nothing about its contents comes with it.
    expect((await readerUser.listOutputs()).outputs).toEqual([]);
  });

  it("starts unread tracking only at the first open, from that open's baselines", async () => {
    let fixture = await setup();
    let reader = person("Reader");
    let readerUser = await signedUp(reader);
    await share(fixture, reader.id, "workspace");
    await vi.waitFor(async () => expect((await listing(readerUser, fixture.workspaceId))?.newShare).toBeDefined());

    // The workspace already fans out to a "build" collaborator it has no observer checks for;
    // until they open it, their account takes none of it.
    await appendMessage(fixture, 0);
    await appendMessage(fixture, 1);
    expect(await cursor(readerUser, fixture.workspaceId)).toBeUndefined();
    expect((await readerUser.getUnreadSummary()).unreadMessageCount).toBe(0);

    await asUser(fixture, readerUser, reader, async () => {});
    await vi.waitFor(async () => {
      let opened = await listing(readerUser, fixture.workspaceId);
      expect(opened).toMatchObject({role: "build"});
      expect(opened).not.toHaveProperty("newShare");
    });
    // The history before the first open counts as read and notified, as for any first admission.
    expect(await cursor(readerUser, fixture.workspaceId)).toMatchObject({
      readThroughSequence: 1, readThroughVisibleSequence: 2, unreadCount: 0, notifiedThroughSequence: 1,
    });
    await appendMessage(fixture, 2);
    expect((await readerUser.getUnreadSummary()).unreadMessageCount).toBe(1);
  });

  it("removes the listing, notice and all, when access is removed before the first open", async () => {
    let fixture = await setup();
    let reader = person("Reader");
    let readerUser = await signedUp(reader);
    await share(fixture, reader.id, "workspace");
    await vi.waitFor(async () => expect(await listing(readerUser, fixture.workspaceId)).toBeDefined());

    await asUser(fixture, fixture.ownerUser, fixture.owner, session => session.removeCollaborator(reader.id, []));
    await vi.waitFor(async () => expect(await listing(readerUser, fixture.workspaceId)).toBeUndefined());
  });

  it("lists a gadget grant with \"use\", and marks it new again only when access widens", async () => {
    let fixture = await setup();
    let reader = person("Reader");
    let readerUser = await signedUp(reader);
    await share(fixture, reader.id, {gadgetId: 100});
    await vi.waitFor(async () => expect(await listing(readerUser, fixture.workspaceId))
      .toMatchObject({role: "use", newShare: {sharedBy: fixture.owner}}));

    await asUser(fixture, readerUser, reader, async () => {});
    await vi.waitFor(async () => expect(await listing(readerUser, fixture.workspaceId)).not.toHaveProperty("newShare"));

    // Granting what they hold changes only the note: nothing to tell them.
    await asUser(fixture, fixture.ownerUser, fixture.owner, async (session, impl) => {
      let announce = vi.spyOn(impl, "announceShare");
      await session.addCollaborator(reader.id, {gadgetId: 100}, "Updated note");
      expect(announce).not.toHaveBeenCalled();
    });

    await share(fixture, reader.id, {gadgetId: 101});
    await vi.waitFor(async () => expect(await listing(readerUser, fixture.workspaceId))
      .toMatchObject({role: "use", newShare: {sharedBy: fixture.owner}}));
    await share(fixture, reader.id, "workspace");
    await vi.waitFor(async () => expect(await listing(readerUser, fixture.workspaceId))
      .toMatchObject({role: "build", newShare: {sharedBy: fixture.owner}}));
  });

  it("names the collaborator who shared it", async () => {
    let fixture = await setup();
    let [member, reader] = [person("Member"), person("Reader")];
    let [memberUser, readerUser] = await Promise.all([signedUp(member), signedUp(reader)]);
    await share(fixture, member.id, "workspace");
    await asUser(fixture, memberUser, member, session => session.addCollaborator(reader.id, {gadgetId: 100}));
    await vi.waitFor(async () => expect(await listing(readerUser, fixture.workspaceId))
      .toMatchObject({owner: fixture.owner, role: "use", newShare: {sharedBy: member}}));
  });

  it("keeps ownerInvitesOnly's rules and withholds a restricted workspace's title", async () => {
    let fixture = await setup();
    let [member, reader] = [person("Member"), person("Reader")];
    let [memberUser, readerUser] = await Promise.all([signedUp(member), signedUp(reader)]);
    await share(fixture, member.id, "workspace");
    await withImpl(fixture.workspace, async impl => {
      impl.storage.containsRestrictedData.put(true);
      impl.storage.ownerInvitesOnly.put(true);
    });

    await expect(asUser(fixture, memberUser, member, session => session.addCollaborator(reader.id, "workspace")))
      .rejects.toThrow("Only the workspace owner can add people");
    await share(fixture, reader.id, "workspace");
    await vi.waitFor(async () => expect(await listing(readerUser, fixture.workspaceId))
      .toMatchObject({title: "", owner: fixture.owner, newShare: {sharedBy: fixture.owner}}));
  });

  it("does nothing for someone who has never signed in", async () => {
    let fixture = await setup();
    let stranger = person("Stranger");
    expect(await share(fixture, stranger.id, "workspace")).toBeNull();

    let strangerUser = env.TEST_USER.getByName(stranger.id);
    await strangerUser.recordSharedWorkspaceGrant(fixture.workspaceId, "Budget", fixture.owner, "build",
      fixture.owner, undefined);
    await runInDurableObject(strangerUser, (_instance, ctx) => {
      let storage = makeUserStorage(ctx.storage);
      expect(storage.created.get()).toBe(false);
      expect([...storage.gadgets.list()]).toEqual([]);
    });
  });
});

const grant = (user: UserStub, workspaceId: string, owner: AiChatAuthorInfo) =>
  user.recordSharedWorkspaceGrant(workspaceId, "Budget", owner, "build", owner, undefined);

describe("UserDurableObject.recordSharedWorkspaceGrant", () => {
  it("leaves a listing alone once its holder has been admitted with \"build\"", async () => {
    let reader = await signedUp(person("Reader"));
    let owner = person("Owner");
    let workspaceId = crypto.randomUUID();
    await reader.recordSharedWorkspaceOpen(workspaceId, "Budget", owner, "build", []);
    await grant(reader, workspaceId, owner);
    expect(await listing(reader, workspaceId)).not.toHaveProperty("newShare");
  });

  it("never lists the user's own workspace as shared with them", async () => {
    let profile = person("Owner");
    let user = await signedUp(profile);
    let workspaceId = crypto.randomUUID();
    await user.newWorkspace(workspaceId, "Mine");
    await user.setWorkspaceLastActive(workspaceId, new Date(), undefined);
    await grant(user, workspaceId, person("Other"));
    expect(await listing(user, workspaceId)).toMatchObject({title: "Mine"});
    expect(await listing(user, workspaceId)).not.toHaveProperty("owner");
  });

  it("keeps the notice through a role change, and holds outputs until the first open", async () => {
    let reader = await signedUp(person("Reader"));
    let owner = person("Owner");
    let workspaceId = crypto.randomUUID();
    await grant(reader, workspaceId, owner);
    await reader.updateSharedWorkspaceRole(workspaceId, "use");
    expect(await listing(reader, workspaceId)).toMatchObject({role: "use", newShare: {sharedBy: owner}});

    let entry = {workpieceId: 100, title: "Gadget 100", created: new Date(0)};
    await reader.syncWorkspaceOutputs(workspaceId, [entry]);
    expect((await reader.listOutputs()).outputs).toEqual([]);
    await reader.recordSharedWorkspaceOpen(workspaceId, "Budget", owner, "use", []);
    await reader.syncWorkspaceOutputs(workspaceId, [entry]);
    expect((await reader.listOutputs()).outputs).toMatchObject([{workspaceId, workpieceId: 100}]);
  });
});
