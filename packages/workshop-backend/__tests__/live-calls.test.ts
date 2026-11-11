// Gadgets' live calls (live-calls.ts, realtime-kit.ts): a ticket goes only to someone holding the
// gadget, by live access as well as capability; concurrent joins share one meeting; invitations
// reach only people who hold the gadget, from people who can share; and losing a gadget deletes
// the RealtimeKit participant -- revoking every ticket and kicking them from the call -- durably,
// across a failure or a restart.
//
// Runs against real Overseer and User DOs (the TEST_OVERSEER and TEST_USER bindings), opening the
// workspace through OverseerDurableObject.open(), with RealtimeKit replaced by an in-memory fake
// served through RealtimeKitApi's fetch. scheduleAccessRestart is a no-op: a real ctx.abort()
// would kill the test DO, and leaving sessions live is exactly the window the live access checks
// exist for.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type {
  AiChatAuthorInfo, CallInvite, CollaboratorGrant, GadgetClient, NotificationSubscriber, Overseer,
  UserNotification, WorkspaceMetadataWithTimestamps,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";
import { CALL_TICKET_TTL_MS, LiveCalls } from "../src/live-calls.js";
import { LIVE_CALL_PRESET, RealtimeKitApi, realtimeKitConfig } from "../src/realtime-kit.js";
import { getServerConfig } from "../src/deployment-config.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];
type UserStub = DurableObjectStub<UserDurableObject>;

const CONFIG = {accountId: "acct", appId: "app", apiToken: "api-token-SECRET"};

// RealtimeKit, in memory: the routes RealtimeKitApi uses, with a switch to fail requests and a
// gate to hold meeting/participant creation open.
class FakeRealtimeKit {
  presets: string[] = [];
  meetings = new Map<string, {status: string}>();
  participants = new Map<string, {meetingId: string, customId: string, name: string, tokens: number}>();
  // Who is in each meeting's live session, by custom participant id, in join order.
  live = new Map<string, string[]>();
  // Peers of each meeting's session who have already left, listed before those still there.
  left = new Map<string, string[]>();
  requests: string[] = [];
  failing = false;
  hold?: Promise<void>;
  holdDeletes?: Promise<void>;
  // Adding a participant whose custom id the meeting already has returns that participant.
  reuseCustomIds = false;
  #next = 0;

  fetch: typeof fetch = async (input, init) => {
    let url = new URL(String(input));
    let method = init?.method ?? "GET";
    let auth = new Headers(init?.headers).get("Authorization");
    let path = url.pathname.replace(`/client/v4/accounts/${CONFIG.accountId}/realtime/kit/${CONFIG.appId}`, "");
    this.requests.push(`${method} ${path}`);
    if (auth !== `Bearer ${CONFIG.apiToken}`) return reply(401, null);
    if (this.failing) return reply(503, null);
    let body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let m: RegExpMatchArray | null;

    if (path === "/presets" && method === "GET") return reply(200, this.presets.map(name => ({name})));
    if (path === "/presets" && method === "POST") {
      this.presets.push(body.name);
      return reply(201, {id: "preset", name: body.name});
    }
    if (path === "/meetings" && method === "POST") {
      await this.hold;
      let id = `meeting-${++this.#next}`;
      this.meetings.set(id, {status: "ACTIVE"});
      return reply(201, {id});
    }
    if ((m = path.match(/^\/meetings\/([^/]+)$/)) && method === "PATCH") {
      let meeting = this.meetings.get(m[1]);
      if (!meeting) return reply(404, null);
      meeting.status = body.status;
      this.live.delete(m[1]);
      return reply(200, {id: m[1]});
    }
    if ((m = path.match(/^\/meetings\/([^/]+)\/participants$/)) && method === "POST") {
      await this.hold;
      if (body.preset_name !== LIVE_CALL_PRESET) return reply(400, null);
      let meetingId = m[1];
      let reused = this.reuseCustomIds && [...this.participants]
          .find(([, p]) => p.meetingId === meetingId && p.customId === body.custom_participant_id);
      if (reused) {
        reused[1].tokens++;
        return reply(201, {id: reused[0], token: `token-for-${reused[0]}-${reused[1].tokens}`,
          expires_on: body.token.expires_on});
      }
      let id = `participant-${++this.#next}`;
      this.participants.set(id, {meetingId: m[1], customId: body.custom_participant_id, name: body.name, tokens: 1});
      return reply(201, {id, token: `token-for-${id}-1`, expires_on: body.token.expires_on});
    }
    if ((m = path.match(/^\/meetings\/([^/]+)\/participants\/([^/]+)\/token$/)) && method === "POST") {
      let participant = this.participants.get(m[2]);
      if (!participant) return reply(404, null);
      participant.tokens++;
      return reply(200, {token: `token-for-${m[2]}-${participant.tokens}`, expires_on: body.expires_on});
    }
    if ((m = path.match(/^\/meetings\/([^/]+)\/participants\/([^/]+)$/)) && method === "DELETE") {
      await this.holdDeletes;
      let participant = this.participants.get(m[2]);
      if (!participant) return reply(404, null);
      this.participants.delete(m[2]);
      this.live.set(m[1], (this.live.get(m[1]) ?? []).filter(id => id !== participant.customId));
      return reply(200, {});
    }
    if ((m = path.match(/^\/meetings\/([^/]+)\/active-session$/)) && method === "GET") {
      if (!this.live.get(m[1])?.length) return reply(404, null);
      return reply(200, {id: `session-of-${m[1]}`, status: "LIVE"});
    }
    if ((m = path.match(/^\/sessions\/session-of-([^/]+)\/participants$/)) && method === "GET") {
      // page_no counts from 0 here; per_page is honoured, as the real API's maximum of 200 is.
      let perPage = Number(url.searchParams.get("per_page"));
      let page = Number(url.searchParams.get("page_no"));
      let peers = [
        ...(this.left.get(m[1]) ?? []).map((customId, i) => ({
          id: `left-${i}`, custom_participant_id: customId, left_at: "2026-11-11T00:00:00Z",
        })),
        ...(this.live.get(m[1]) ?? []).map(customId => ({
          id: `peer-${customId}`, custom_participant_id: customId, display_name: "ignored",
        })),
      ];
      return reply(200, {participants: peers.slice(page * perPage, (page + 1) * perPage)});
    }
    return reply(404, null);
  };

  // Puts whoever holds the participant behind `token` into its meeting's live session.
  enter(token: string): void {
    let id = token.replace(/^token-for-/, "").replace(/-\d+$/, "");
    let participant = this.participants.get(id)!;
    this.live.set(participant.meetingId, [...this.live.get(participant.meetingId) ?? [], participant.customId]);
  }
}

function reply(status: number, data: unknown): Response {
  let ok = status < 400;
  return Response.json(ok ? {success: true, data} : {success: false, errors: [{code: status}]}, {status});
}

const person = (name: string): AiChatAuthorInfo =>
  ({type: "user", id: `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`, name});

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
  return runInDurableObject(workspace, async (instance: OverseerDurableObject) => {
    let impl = instance["impl"];
    impl.scheduleAccessRestart = async () => {};
    return fn(impl);
  });
}

// An owner and their workspace "Budget" with gadgets 100 and 101, live calls served by `rtk`.
async function setup(rtk = new FakeRealtimeKit()) {
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
    for (let id of [100, 101]) {
      impl.storage.gadgets.put({type: "gadget", id, title: `Gadget ${id}`, created: new Date(0),
        bindingName: `G${id}`, bindings: {}});
    }
    impl.liveCalls = new LiveCalls(impl, new RealtimeKitApi(CONFIG, rtk.fetch));
  });
  return {owner, ownerUser, workspace, workspaceId, rtk};
}
type Fixture = Awaited<ReturnType<typeof setup>>;

// Opens the workspace as `user` through the real open() and runs `fn` on the session.
function asUser<T>(fixture: Fixture, user: UserStub, profile: AiChatAuthorInfo,
    fn: (session: Overseer, impl: Impl) => Promise<T>): Promise<T> {
  return runInDurableObject(fixture.workspace, async (instance: OverseerDurableObject) => {
    let impl = instance["impl"];
    impl.scheduleAccessRestart = async () => {};
    impl.ensureAmbientCapsules = async () => {};
    let session = await instance.open(user.id.toString(), profile.id, new NativeRpcStub(() => {}));
    try {
      return await fn(session, impl);
    } finally {
      (session as unknown as Disposable)[Symbol.dispose]();
    }
  });
}

const asOwner = <T>(fixture: Fixture, fn: (session: Overseer, impl: Impl) => Promise<T>) =>
  asUser(fixture, fixture.ownerUser, fixture.owner, fn);

const share = (fixture: Fixture, username: string, grant: CollaboratorGrant) =>
  asOwner(fixture, session => session.addCollaborator(username, grant));

// A collaborator, signed up and given `grants`.
async function collaborator(fixture: Fixture, name: string, ...grants: CollaboratorGrant[]) {
  let profile = person(name);
  let user = await signedUp(profile);
  for (let grant of grants) await share(fixture, profile.id, grant);
  return {profile, user};
}

const gadget = (session: Overseer, id: number) =>
  session.getGadget(id) as unknown as Promise<GadgetClient>;

// Waits until RealtimeKit has caught up with the cleanup journaled so far.
const cleanedUp = (impl: Impl) => vi.waitFor(async () => {
  await impl.liveCalls.deliverCleanup();
  expect([...impl.storage.callCleanup.list()]).toEqual([]);
});

describe("joinCall", () => {
  it("issues a short-lived ticket named from the profile, reusing the participant", async () => {
    let fixture = await setup();
    await asOwner(fixture, async session => {
      let before = Date.now();
      let first = await (await gadget(session, 100)).joinCall();
      let second = await (await gadget(session, 100)).joinCall();

      expect(first.displayName).toBe("Owner");
      expect(first.expiresAt.getTime()).toBeGreaterThanOrEqual(before + CALL_TICKET_TTL_MS - 1_000);
      expect(first.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + CALL_TICKET_TTL_MS);
      expect(second.authToken).not.toBe(first.authToken);
      expect(fixture.rtk.presets).toEqual([LIVE_CALL_PRESET]);
      expect(fixture.rtk.meetings.size).toBe(1);
      // One participant, identified by the opaque User DO id rather than the email.
      let participants = [...fixture.rtk.participants.values()];
      expect(participants).toEqual([expect.objectContaining({customId: fixture.ownerUser.id.toString()})]);
      expect(participants[0].customId).not.toContain("@");
    });
  });

  it("lets a use collaborator join the call of a gadget they hold, and only that one", async () => {
    let fixture = await setup();
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    await asUser(fixture, viewer.user, viewer.profile, async session => {
      let ticket = await (await gadget(session, 100)).joinCall();
      expect(ticket.displayName).toBe("Viewer");
      // Their access names no other gadget, so there is no capability to ask with at all.
      await expect(gadget(session, 101)).rejects.toThrow("No such gadget: 101");
    });
    expect([...fixture.rtk.meetings.keys()]).toHaveLength(1);
  });

  it("checks live access, not just the capability: a gadget lost meanwhile gets no ticket", async () => {
    let fixture = await setup();
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100}, {gadgetId: 101});
    await runInDurableObject(fixture.workspace, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      impl.scheduleAccessRestart = async () => {};
      impl.ensureAmbientCapsules = async () => {};
      let open = (user: UserStub, profile: AiChatAuthorInfo) =>
          instance.open(user.id.toString(), profile.id, new NativeRpcStub(() => {}));
      let session = await open(viewer.user, viewer.profile);
      let held = await gadget(session, 101);
      // Removed from 101 while still holding its capability (the restart is a no-op here).
      await (await open(fixture.ownerUser, fixture.owner)).removeCollaborator(viewer.profile.id, [], 101);

      await expect(held.joinCall()).rejects.toThrow("No such gadget: 101");
      await expect((await gadget(session, 100)).joinCall()).resolves.toMatchObject({displayName: "Viewer"});
    });
  });

  it("refuses a gadget still provisional to a chat", async () => {
    let fixture = await setup();
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatMeta.put({id: 1, title: "Draft", started: new Date(), lastActive: new Date()});
      impl.storage.gadgets.put({type: "gadget", id: 102, title: "Draft", created: new Date(0),
        bindingName: "G102", bindings: {}, pending: {chatId: 1}});
    });
    await asOwner(fixture, async session => {
      await expect((await gadget(session, 102)).joinCall()).rejects.toThrow("No such gadget: 102");
    });
    expect(fixture.rtk.meetings.size).toBe(0);
  });

  it("creates one meeting for concurrent joins, and one participant per person", async () => {
    let fixture = await setup();
    let builder = await collaborator(fixture, "Builder", "workspace");
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    let release!: () => void;
    fixture.rtk.hold = new Promise(resolve => { release = resolve; });

    let joins = [
      asOwner(fixture, async s => [await (await gadget(s, 100)).joinCall(), await Promise.resolve()]),
      asOwner(fixture, async s => (await gadget(s, 100)).joinCall()),
      asUser(fixture, builder.user, builder.profile, async s => (await gadget(s, 100)).joinCall()),
      asUser(fixture, viewer.user, viewer.profile, async s => (await gadget(s, 100)).joinCall()),
    ];
    await vi.waitFor(() => expect(fixture.rtk.requests.filter(r => r === "POST /meetings")).toHaveLength(1));
    release();
    await Promise.all(joins);

    expect(fixture.rtk.meetings.size).toBe(1);
    let customIds = [...fixture.rtk.participants.values()].map(p => p.customId).toSorted();
    expect(customIds).toEqual([
      fixture.ownerUser.id.toString(), builder.user.id.toString(), viewer.user.id.toString(),
    ].toSorted());
  });

  it("issues no ticket, and retires the participant, when access is lost mid-join", async () => {
    let fixture = await setup();
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    // The meeting exists already, so only adding the participant is held.
    await asOwner(fixture, async s => (await gadget(s, 100)).joinCall());
    let release!: () => void;
    fixture.rtk.hold = new Promise(resolve => { release = resolve; });

    let join = asUser(fixture, viewer.user, viewer.profile, async s => (await gadget(s, 100)).joinCall());
    let outcome = join.catch((error: Error) => error);
    await vi.waitFor(() => expect(fixture.rtk.requests.filter(r => r.endsWith("/participants"))).toHaveLength(2));
    await asOwner(fixture, owner => owner.removeCollaborator(viewer.profile.id, [], 100));
    release();

    expect(await outcome).toEqual(new Error("No such gadget: 100"));
    await withImpl(fixture.workspace, async impl => {
      await cleanedUp(impl);
      expect([...impl.storage.callParticipants.list()].map(p => p.profileId)).toEqual([fixture.owner.id]);
    });
    expect([...fixture.rtk.participants.values()].map(p => p.customId)).toEqual([fixture.ownerUser.id.toString()]);
  });
});

describe("getCallRoster", () => {
  it("lists who is live in join order, shared between viewers for a few seconds", async () => {
    let fixture = await setup();
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    let ownerTicket = await asOwner(fixture, async s => (await gadget(s, 100)).joinCall());
    let viewerTicket = await asUser(fixture, viewer.user, viewer.profile, async s => (await gadget(s, 100)).joinCall());
    fixture.rtk.enter(viewerTicket.authToken);
    fixture.rtk.enter(ownerTicket.authToken);

    await asOwner(fixture, async session => {
      let roster = await (await gadget(session, 100)).getCallRoster();
      expect(roster).toEqual([
        {profileId: viewer.profile.id, name: "Viewer", callParticipantId: viewer.user.id.toString()},
        {profileId: fixture.owner.id, name: "Owner", callParticipantId: fixture.ownerUser.id.toString()},
      ]);
      let lookups = fixture.rtk.requests.length;
      await (await gadget(session, 100)).getCallRoster();
      expect(fixture.rtk.requests.length).toBe(lookups);
      // A gadget with no call yet costs no lookup at all.
      expect(await (await gadget(session, 101)).getCallRoster()).toEqual([]);
      expect(fixture.rtk.requests.length).toBe(lookups);
    });

    // Someone revoked drops out at once, cached lookup or not.
    await asOwner(fixture, owner => owner.removeCollaborator(viewer.profile.id, [], 100));
    await asOwner(fixture, async session => {
      expect((await (await gadget(session, 100)).getCallRoster()).map(e => e.name)).toEqual(["Owner"]);
    });
  });
});

describe("getCallRoster across a long session", () => {
  it("finds people still live past the first page of peers who left", async () => {
    let fixture = await setup();
    let ticket = await asOwner(fixture, async s => (await gadget(s, 100)).joinCall());
    let meetingId = [...fixture.rtk.meetings.keys()][0];
    fixture.rtk.left.set(meetingId, Array.from({length: 450}, (_, i) => `gone-${i}`));
    fixture.rtk.enter(ticket.authToken);

    await asOwner(fixture, async session => {
      expect((await (await gadget(session, 100)).getCallRoster()).map(e => e.name)).toEqual(["Owner"]);
    });
    expect(fixture.rtk.requests.filter(r => r.startsWith("GET /sessions/"))).toHaveLength(3);
  });
});

describe("revocation", () => {
  it("deletes the participant of someone who loses the gadget, kicking them from the call", async () => {
    let fixture = await setup();
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100}, {gadgetId: 101});
    let ticket = await asUser(fixture, viewer.user, viewer.profile, async s => {
      await (await gadget(s, 101)).joinCall();
      return (await gadget(s, 100)).joinCall();
    });
    fixture.rtk.enter(ticket.authToken);

    await asOwner(fixture, owner => owner.removeCollaborator(viewer.profile.id, [], 100));
    await withImpl(fixture.workspace, impl => cleanedUp(impl));

    // Gone from 100's call and its live session; their participant in 101's call is untouched.
    let remaining = [...fixture.rtk.participants.values()];
    expect(remaining).toEqual([expect.objectContaining({customId: viewer.user.id.toString()})]);
    expect(fixture.rtk.meetings.get(remaining[0].meetingId)).toBeDefined();
    expect([...fixture.rtk.live.values()].flat()).toEqual([]);
  });

  it("revokes everyone who lost a gadget transitively, and on a share link's revocation", async () => {
    let fixture = await setup();
    let builder = await collaborator(fixture, "Builder", "workspace");
    let link = await asUser(fixture, builder.user, builder.profile, s => s.createShareLink({gadgetId: 100}));
    let joiner = person("Joiner");
    let joinerUser = await signedUp(joiner);
    await runInDurableObject(fixture.workspace, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      impl.scheduleAccessRestart = async () => {};
      impl.ensureAmbientCapsules = async () => {};
      let session = await instance.open(joinerUser.id.toString(), joiner.id, new NativeRpcStub(() => {}), link.key);
      await (await gadget(session, 100)).joinCall();
      (session as unknown as Disposable)[Symbol.dispose]();
    });
    expect(fixture.rtk.participants.size).toBe(1);

    await asOwner(fixture, owner => owner.revokeShareLink(link.linkId, []));
    await withImpl(fixture.workspace, impl => cleanedUp(impl));
    expect(fixture.rtk.participants.size).toBe(0);
  });

  it("keeps the deletion journaled through a failure and a restart, until RealtimeKit confirms", async () => {
    let fixture = await setup();
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    await asUser(fixture, viewer.user, viewer.profile, async s => (await gadget(s, 100)).joinCall());
    fixture.rtk.failing = true;

    await asOwner(fixture, owner => owner.removeCollaborator(viewer.profile.id, [], 100));
    await withImpl(fixture.workspace, async impl => {
      await impl.liveCalls.deliverCleanup();
      expect([...impl.storage.callCleanup.list()]).toEqual([
        expect.objectContaining({participantId: expect.any(String)}),
      ]);
      // The alarm is armed to retry it.
      expect(await impl.ctx.storage.getAlarm()).not.toBeNull();
    });
    expect(fixture.rtk.participants.size).toBe(1);

    // A fresh LiveCalls over the same storage is what the Overseer has after its restart.
    fixture.rtk.failing = false;
    await withImpl(fixture.workspace, async impl => {
      impl.liveCalls = new LiveCalls(impl, new RealtimeKitApi(CONFIG, fixture.rtk.fetch));
      expect(impl.liveCalls.hasPendingCleanup()).toBe(true);
      await impl.runAlarmTasks();
      expect([...impl.storage.callCleanup.list()]).toEqual([]);
    });
    expect(fixture.rtk.participants.size).toBe(0);
  });

  it("closes a deleted gadget's call", async () => {
    let fixture = await setup();
    let ticket = await asOwner(fixture, async s => (await gadget(s, 100)).joinCall());
    fixture.rtk.enter(ticket.authToken);

    await withImpl(fixture.workspace, async impl => {
      await impl.removeWorkpiece(100);
      await cleanedUp(impl);
      expect([...impl.storage.callMeetings.list()]).toEqual([]);
    });
    expect([...fixture.rtk.meetings.values()]).toEqual([{status: "INACTIVE"}]);
    expect(fixture.rtk.participants.size).toBe(0);
  });

  it("wipes a deleted workspace at once, keeping only the call cleanup still owed", async () => {
    let fixture = await setup();
    let owner = await asOwner(fixture, async s => (await gadget(s, 100)).joinCall());
    fixture.rtk.enter(owner.authToken);
    fixture.rtk.failing = true;

    await withImpl(fixture.workspace, async impl => {
      // As deleteSelf() does: the owner forgets the workspace before its storage goes.
      impl.beginDeletion(new Set([fixture.ownerUser.id.toString()]));
      await impl.runAlarmTasks();
      // Everything but the journal is gone, and the alarm still retries it.
      let keys = [...(await impl.ctx.storage.list()).keys()];
      expect(keys.length).toBe(2);
      expect(keys.every(key => key.startsWith("callCleanup:"))).toBe(true);
      expect(await impl.ctx.storage.getAlarm()).not.toBeNull();
    });
    // What remains opens as not found, as any wiped workspace does: open() finds no owner and asks
    // the owner's account, which no longer lists it. (Opening here would reset the test's DO.)
    await withImpl(fixture.workspace, async impl => {
      expect(impl.storage.deleting.get()).toBe(false);
      expect(impl.storage.ownerId.get()).toBeUndefined();
    });
    expect(await fixture.ownerUser.getWorkspace(fixture.workspaceId)).toBeNull();

    fixture.rtk.failing = false;
    await withImpl(fixture.workspace, async impl => {
      await impl.runAlarmTasks();
      expect(await impl.ctx.storage.list()).toEqual(new Map());
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
    });
    expect([...fixture.rtk.meetings.values()]).toEqual([{status: "INACTIVE"}]);
    expect(fixture.rtk.participants.size).toBe(0);
  });

  it("deletes a re-added person's owed participant before their next ticket", async () => {
    let fixture = await setup();
    fixture.rtk.reuseCustomIds = true;
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    let join = () => asUser(fixture, viewer.user, viewer.profile, async s => (await gadget(s, 100)).joinCall());
    await join();
    fixture.rtk.failing = true;
    await asOwner(fixture, owner => owner.removeCollaborator(viewer.profile.id, [], 100));
    await share(fixture, viewer.profile.id, {gadgetId: 100});

    // The deletion still can't be delivered, so neither can a ticket.
    await expect(join()).rejects.toThrow("still being removed");

    fixture.rtk.failing = false;
    fixture.rtk.requests = [];
    let ticket = await join();
    fixture.rtk.enter(ticket.authToken);
    let deleted = fixture.rtk.requests.findIndex(r => r.startsWith("DELETE /meetings/"));
    let added = fixture.rtk.requests.findIndex(r => /^POST \/meetings\/[^/]+\/participants$/.test(r));
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeLessThan(added);
    // Nothing is left to land late and kick them from the call they just joined.
    await withImpl(fixture.workspace, impl => cleanedUp(impl));
    expect([...fixture.rtk.live.values()].flat()).toEqual([viewer.user.id.toString()]);
  });

  it("waits out a cleanup pass already deleting their participant before a re-added person joins", async () => {
    let fixture = await setup();
    fixture.rtk.reuseCustomIds = true;
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    let join = () => asUser(fixture, viewer.user, viewer.profile, async s => (await gadget(s, 100)).joinCall());
    await join();
    let release!: () => void;
    fixture.rtk.holdDeletes = new Promise(resolve => { release = resolve; });

    await asOwner(fixture, owner => owner.removeCollaborator(viewer.profile.id, [], 100));
    await vi.waitFor(() => expect(fixture.rtk.requests.some(r => r.startsWith("DELETE"))).toBe(true));
    await share(fixture, viewer.profile.id, {gadgetId: 100});
    let joined = join();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fixture.rtk.requests.filter(r => /^POST \/meetings\/[^/]+\/participants$/.test(r))).toHaveLength(1);
    release();

    let ticket = await joined;
    fixture.rtk.enter(ticket.authToken);
    await withImpl(fixture.workspace, impl => cleanedUp(impl));
    expect([...fixture.rtk.live.values()].flat()).toEqual([viewer.user.id.toString()]);
  });
});

// RPC exposes prototype methods only, as the browser's NotificationSubscriberImpl defines them.
class Tab extends RpcTarget {
  invites: CallInvite[] = [];
  async notify(_notification: UserNotification): Promise<void> {}
  async workspaceShared(_workspace: WorkspaceMetadataWithTimestamps): Promise<void> {}
  async callInvite(invite: CallInvite): Promise<void> {
    this.invites.push(invite);
  }
}

// A tab from before live calls, which has no callInvite().
class OldTab extends RpcTarget {
  async notify(_notification: UserNotification): Promise<void> {}
  async workspaceShared(_workspace: WorkspaceMetadataWithTimestamps): Promise<void> {}
}

const subscribe = (user: UserStub, tab: RpcTarget) => runInDurableObject(user, instance =>
  instance.subscribeToNotifications(new RpcStub(tab) as unknown as RpcStub<NotificationSubscriber>));

describe("inviteToCall", () => {
  it("tells the invitee's open tabs, old ones without the method notwithstanding", async () => {
    let fixture = await setup();
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    let tab = new Tab();
    await subscribe(viewer.user, new OldTab());
    await subscribe(viewer.user, tab);

    await asOwner(fixture, async s => (await gadget(s, 100)).inviteToCall(viewer.profile.id));

    await vi.waitFor(() => expect(tab.invites).toEqual([{
      workspaceId: fixture.workspaceId, gadgetId: 100, gadgetTitle: "Gadget 100",
      inviter: expect.objectContaining({id: fixture.owner.id, name: "Owner"}),
    }]));
  });

  it("withholds the gadget's title once the workspace holds restricted data", async () => {
    let fixture = await setup();
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    let tab = new Tab();
    await subscribe(viewer.user, tab);
    await withImpl(fixture.workspace, async impl => impl.storage.containsRestrictedData.put(true));

    await asOwner(fixture, async s => (await gadget(s, 100)).inviteToCall(viewer.profile.id));

    await vi.waitFor(() => expect(tab.invites).toEqual([expect.objectContaining({gadgetTitle: ""})]));
  });

  it("is refused for someone who doesn't hold the gadget, and repeated too soon", async () => {
    let fixture = await setup();
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    let stranger = person("Stranger");
    await signedUp(stranger);

    await asOwner(fixture, async session => {
      await expect((await gadget(session, 101)).inviteToCall(viewer.profile.id))
          .rejects.toThrow("Share it with them first");
      await expect((await gadget(session, 100)).inviteToCall(stranger.id))
          .rejects.toThrow("Share it with them first");
      await (await gadget(session, 100)).inviteToCall(viewer.profile.id);
      await expect((await gadget(session, 100)).inviteToCall(viewer.profile.id))
          .rejects.toThrow("just invited");
    });
  });

  it("is refused to someone demoted from build who still holds the capability", async () => {
    let fixture = await setup();
    let builder = await collaborator(fixture, "Builder", "workspace", {gadgetId: 100});
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    await runInDurableObject(fixture.workspace, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      impl.scheduleAccessRestart = async () => {};
      impl.ensureAmbientCapsules = async () => {};
      let open = (user: UserStub, profile: AiChatAuthorInfo) =>
          instance.open(user.id.toString(), profile.id, new NativeRpcStub(() => {}));
      let held = await gadget(await open(builder.user, builder.profile), 100);
      // Left with use of gadget 100 alone (the restart is a no-op here).
      let owner = await open(fixture.ownerUser, fixture.owner);
      let edges = impl.storage.collaborators.get(builder.profile.id)!.addedBy;
      expect(edges.some(edge => (edge.role ?? "build") === "build")).toBe(true);
      await owner.removeCollaborator(builder.profile.id, []);
      await owner.addCollaborator(builder.profile.id, {gadgetId: 100});

      await expect(held.inviteToCall(viewer.profile.id)).rejects.toThrow("Unauthorized");
    });
  });

  it("is refused to a use collaborator, who cannot share", async () => {
    let fixture = await setup();
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    await asUser(fixture, viewer.user, viewer.profile, async session => {
      await expect((await gadget(session, 100)).inviteToCall(fixture.owner.id))
          .rejects.toThrow("Unauthorized");
    });
  });
});

describe("an unconfigured deployment", () => {
  it("has live calls off, and refuses each call clearly", async () => {
    expect(realtimeKitConfig({} as Cloudflare.Env)).toBeNull();
    expect(realtimeKitConfig({REALTIMEKIT_ACCOUNT_ID: "a", REALTIMEKIT_APP_ID: "b"} as Cloudflare.Env)).toBeNull();
    expect(realtimeKitConfig({
      REALTIMEKIT_ACCOUNT_ID: "a", REALTIMEKIT_APP_ID: "b", REALTIMEKIT_API_TOKEN: "c",
    } as Cloudflare.Env)).toEqual({accountId: "a", appId: "b", apiToken: "c"});
    let deployment = {...env, BLUEPRINTS: {get: async () => null}} as unknown as Cloudflare.Env;
    expect((await getServerConfig(deployment)).liveCallsEnabled).toBe(false);
    expect((await getServerConfig({...deployment, REALTIMEKIT_ACCOUNT_ID: "a", REALTIMEKIT_APP_ID: "b",
      REALTIMEKIT_API_TOKEN: "c"})).liveCallsEnabled).toBe(true);

    let fixture = await setup();
    let viewer = await collaborator(fixture, "Viewer", {gadgetId: 100});
    await withImpl(fixture.workspace, async impl => { impl.liveCalls = new LiveCalls(impl, null); });
    await asOwner(fixture, async session => {
      let client = await gadget(session, 100);
      await expect(client.joinCall()).rejects.toThrow("Live calls are not available");
      await expect(client.getCallRoster()).rejects.toThrow("Live calls are not available");
      await expect(client.inviteToCall(viewer.profile.id)).rejects.toThrow("Live calls are not available");
    });
    expect(fixture.rtk.requests).toEqual([]);
  });
});

// Answers every request with an error echoing the request's credentials and a participant token.
const echoCredentials: typeof fetch = async (_input, init) => Response.json({
  success: false,
  errors: [{code: 1000, message: `bad ${new Headers(init?.headers).get("Authorization")}`}],
  data: {token: "participant-token-SECRET"},
}, {status: 401});

describe("RealtimeKitApi", () => {
  it("never puts the API token or a participant token in an error", async () => {
    let api = new RealtimeKitApi(CONFIG, echoCredentials);
    let error = await api.addParticipant("m", {customParticipantId: "u", name: "n", expiresAt: new Date()})
        .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toBe(
        "RealtimeKit POST /meetings/m/participants failed with HTTP 401 (1000).");
    expect(JSON.stringify(error)).not.toContain("SECRET");
  });
});
