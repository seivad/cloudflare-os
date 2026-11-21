// A user's cost summary (UserDurableObject.getCostSummary()): the workspaces they own, as each
// one's Overseer delivers its cost, the workspaces they deleted, and their own spend. Runs against
// a real User DO (the TEST_USER binding); integration-tests/__tests__/workspace-costs.test.ts
// covers delivery from a real Overseer.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { AiChatAuthorInfo, CostLine } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const person = (name: string): AiChatAuthorInfo =>
  ({type: "user", id: `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`, name});

async function signedUp(profile: AiChatAuthorInfo) {
  let user = env.TEST_USER.getByName(profile.id);
  await runInDurableObject(user, (_instance, ctx) => {
    let storage = makeUserStorage(ctx.storage);
    storage.profile.put(profile);
    storage.created.put(true);
  });
  return user;
}

const TEXT: CostLine = {kind: "text", model: "@cf/zai-org/glm-5.2", estimated: false, usd: 1.5, requests: 3};
const IMAGE: CostLine = {kind: "image", model: "@cf/image-model", estimated: true, usd: 0.5, requests: 1};

it("counts owned workspaces, shows their uncounted rest as earlier, and leaves shared ones out",
    async () => {
  let user = await signedUp(person("Owner"));
  let owned = crypto.randomUUID();
  let old = crypto.randomUUID();
  let shared = crypto.randomUUID();
  await user.newWorkspace(owned, "Mine");
  await user.setWorkspaceLastActive(owned, new Date());
  await user.newWorkspace(old, "Old");
  await user.recordSharedWorkspaceOpen(shared, "Theirs", person("Other"), "build", []);
  // A workspace whose total was counted before costs were broken down.
  await runInDurableObject(user, (_instance, ctx) => {
    let storage = makeUserStorage(ctx.storage);
    storage.gadgets.put({...storage.gadgets.get(old)!, totalCost: 0.25});
  });

  await user.setWorkspaceCost(owned, 2, [TEXT, IMAGE]);
  await user.setWorkspaceCost(shared, 9, [IMAGE]);
  await user.addOwnCost({kind: "transcription", model: "@cf/openai/whisper", estimated: true,
    usd: 0.125, source: "voice"});

  let earlier: CostLine = {kind: "text", model: "earlier", estimated: false, usd: 0.25, requests: 0};
  let voice: CostLine = {kind: "transcription", model: "@cf/openai/whisper", estimated: true,
    usd: 0.125, requests: 1};
  expect(await user.getCostSummary()).toEqual({
    totalCost: 2.375,
    byKind: {text: 1.75, image: 0.5, transcription: 0.125},
    byModel: {[TEXT.model]: 1.5, [IMAGE.model]: 0.5, earlier: 0.25, "@cf/openai/whisper": 0.125},
    workspaces: [
      {workspaceId: owned, title: "Mine", totalCost: 2, lines: [TEXT, IMAGE]},
      {workspaceId: old, title: "Old", totalCost: 0.25, lines: [earlier]},
    ].toSorted((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    deletedWorkspaces: {totalCost: 0, lines: []},
    own: {totalCost: 0.125, lines: [voice]},
  });
  // The breakdown is the summary's, not the workspace list's.
  expect((await user.listWorkspaces()).find(workspace => workspace.id === owned))
      .not.toHaveProperty("costLines");
  expect((await user.listWorkspaces()).find(workspace => workspace.id === shared))
      .not.toHaveProperty("totalCost");
});

it("keeps a removed workspace's final cost in the deleted bucket, and forgets a shared one's",
    async () => {
  let user = await signedUp(person("Owner"));
  let first = crypto.randomUUID();
  let second = crypto.randomUUID();
  let shared = crypto.randomUUID();
  await user.newWorkspace(first, "First");
  await user.newWorkspace(second, "Second");
  await user.recordSharedWorkspaceOpen(shared, "Theirs", person("Other"), "build", []);
  await user.setWorkspaceCost(first, 1.5, [TEXT]);
  await user.setWorkspaceCost(second, 0.5, [IMAGE]);

  // Its Overseer hands over the cost it counted since it last delivered one.
  await user.workspaceRemoved(first, {totalCost: 3, lines: [{...TEXT, usd: 3, requests: 6}]});
  await user.deleteWorkspace(second);
  await user.workspaceRemoved(shared, {totalCost: 9, lines: [IMAGE]});
  await user.workspaceRemoved(first, {totalCost: 3, lines: [{...TEXT, usd: 3, requests: 6}]});

  expect(await user.getCostSummary()).toEqual({
    totalCost: 3.5,
    byKind: {text: 3, image: 0.5},
    byModel: {[TEXT.model]: 3, [IMAGE.model]: 0.5},
    workspaces: [],
    deletedWorkspaces: {totalCost: 3.5, lines: [{...TEXT, usd: 3, requests: 6}, IMAGE]},
    own: {totalCost: 0, lines: []},
  });
});

// The integration harness runs no Workers AI binding, so voice can't be called there: the User DO
// is given a stand-in binding that answers the gateway's log read.
it("voice spend lands on the user's own ledger, not a workspace", async () => {
  let profile = person("Speaker");
  let user = await signedUp(profile);
  let workspace = crypto.randomUUID();
  await user.newWorkspace(workspace, "Mine");
  await runInDurableObject(user, async (instance, ctx) => {
    let bound = instance as unknown as {env: Record<string, unknown>};
    bound.env = {...instance.env, CF_AI_GATEWAY: "platform-gateway", CF_AI_GATEWAY_ACCOUNT_ID: "account",
      WORKERS_AI: {gateway: () => ({getLog: async (id: string) => id === "v-1" ? {cost: 0.0125, metadata: {user: profile.id}} : id === "theirs" ? {cost: 9, metadata: {user: "bo@example.com"}} : {cost: undefined}})}};
    instance.recordVoiceCost({kind: "transcription", model: "@cf/openai/whisper", gatewayLogId: "v-1"});
    // The same log twice counts once, another user's log counts nothing, and no log id counts nothing.
    instance.recordVoiceCost({kind: "transcription", model: "@cf/openai/whisper", gatewayLogId: "v-1"});
    instance.recordVoiceCost({kind: "speech", model: "@cf/deepgram/aura-2-en", gatewayLogId: "theirs"});
    instance.recordVoiceCost({kind: "speech", model: "@cf/deepgram/aura-2-en"});
    await ctx.waitUntil(Promise.resolve());
  });
  await expect.poll(async () => (await user.getCostSummary()).own.totalCost).toBe(0.0125);

  // A stale id naming the counted log again, later, counts nothing.
  await runInDurableObject(user, (instance) => {
    instance.recordVoiceCost({kind: "transcription", model: "@cf/openai/whisper", gatewayLogId: "v-1"});
  });
  await new Promise(resolve => setTimeout(resolve, 100));

  let summary = await user.getCostSummary();
  expect(summary.own.lines).toEqual([{kind: "transcription", model: "@cf/openai/whisper",
    estimated: false, usd: 0.0125, requests: 1}]);
  expect(summary.totalCost).toBe(0.0125);
  expect(summary.byKind).toEqual({transcription: 0.0125});
  expect(summary.workspaces).toEqual([]);
});
