import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi, UserCostSummary } from "@gadgets/workshop-shared/api";
import type { RpcStub } from "capnweb";
import { startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedChatCompletions } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, nextUsernames, signUp, waitFor, waitForIdleChat,
} from "../src/rpc-client.js";

const LOGS_URL = "https://api.cloudflare.com/client/v4/accounts/gateway-account-id/ai-gateway/gateways/" +
    "platform-gateway/logs/";
// Every chat turn is logged at TURN_COST, and every chat's title, which the deployment's quick
// model writes, at TITLE_COST.
const TURN_LOG_URL = `${LOGS_URL}turn-log-id`;
const TITLE_LOG_URL = `${LOGS_URL}title-log-id`;
const TURN_COST = 1.25;
const TITLE_COST = 0.25;
const CHAT_COST = TURN_COST + TITLE_COST;
// What the Workshop asks the gateway to learn which providers it holds a key for.
const KEY_CHECK_URLS = ["openai/models", "anthropic/v1/models?limit=1", "openrouter/v1/key"]
    .map(path => `https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/${path}`);

// One reply for each chat turn the cases below run.
const model = scriptedChatCompletions([
  { text: "Charged reply." }, { text: "Shared reply." }, { text: "Deleted reply." },
]);
const network = new NetworkInterceptor({
  handlers: [async (url, method, headers, request) => {
    if (method === "GET" && url.href === TURN_LOG_URL) {
      return Response.json({ success: true, result: { cost: TURN_COST } });
    }
    if (method === "GET" && url.href === TITLE_LOG_URL) {
      return Response.json({ success: true, result: { cost: TITLE_COST } });
    }
    // The gateway holds no key for any provider it is asked about.
    if (method === "GET" && KEY_CHECK_URLS.includes(url.href)) {
      return new Response("no key", { status: 401 });
    }
    // A turn and its title are requested together, so each is told apart by its own attribution.
    const metadata: unknown = JSON.parse(headers.get("cf-aig-metadata") ?? "{}");
    const logId = (metadata as { source?: string }).source === "thread-title"
      ? "title-log-id" : "turn-log-id";
    const response = await model.handler(url, method, headers, request);
    return response && new Response(response.body, {
      status: response.status,
      headers: { ...Object.fromEntries(response.headers), "cf-aig-log-id": logId },
    });
  }],
});
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    // The HTTPS transport reads the log with a plain fetch the interceptor answers.
    patchWorkshop: config => {
      config.vars = {
        ...config.vars,
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
        CF_AI_GATEWAY_API_TOKEN: "read-run-token",
        CF_AI_GATEWAY_USE_BINDING: "false",
        CF_AI_GATEWAY_PROVIDERS: "cloudflare",
      };
    },
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
    expect(model.remainingSteps()).toBe(0);
  } finally {
    network.uninstall();
  }
});

const NOTHING: UserCostSummary = {
  totalCost: 0, byKind: {}, byModel: {}, workspaces: [],
  deletedWorkspaces: { totalCost: 0, lines: [] }, own: { totalCost: 0, lines: [] },
};

// The caller's summary, once it counts `total`: a workspace's costs reach its owner after the
// gateway logs are read.
function summaryCounting(api: RpcStub<AuthenticatedApi>, total: number): Promise<UserCostSummary> {
  return waitFor(`a summary counting ${total}`, async () => {
    const summary = await api.getMyCostSummary();
    return summary.totalCost === total ? summary : null;
  });
}

it("the owner's summary matches the workspace's lines after a charged turn", async () => {
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("costowner")[0]!);
  expect(await api.getMyCostSummary()).toEqual(NOTHING);
  using ws = await api.newWorkspace();
  const { id: workspaceId } = await ws.getMetadata();

  const chatId = await ws.newChat("What does this cost?", SCRIPTED_MODEL_ID);
  await waitForIdleChat(ws, chatId);
  const summary = await summaryCounting(api, CHAT_COST);

  expect((await ws.getMetadata()).totalCost).toBe(CHAT_COST);
  expect(summary.workspaces).toEqual([
    { workspaceId, title: expect.any(String), totalCost: CHAT_COST, lines: expect.any(Array) },
  ]);
  const lines = summary.workspaces[0]!.lines;
  expect(lines).toHaveLength(2);
  expect(lines).toContainEqual(expect.objectContaining(
      { kind: "text", model: SCRIPTED_MODEL_ID, estimated: false, usd: TURN_COST, requests: 1 }));
  expect(lines).toContainEqual(expect.objectContaining(
      { kind: "text", estimated: false, usd: TITLE_COST, requests: 1 }));
  expect(summary.byKind).toEqual({ text: CHAT_COST });
  expect(Object.values(summary.byModel).reduce((sum, usd) => sum + usd, 0)).toBe(CHAT_COST);
  expect(summary.deletedWorkspaces).toEqual(NOTHING.deletedWorkspaces);
  expect(summary.own).toEqual(NOTHING.own);
});

it("a collaborator's summary does not include a workspace shared with them", async () => {
  const [ownerName, collaboratorName] = nextUsernames("costsharer", "costcollaborator");
  using ownerPublic = connect(harness.url);
  using owner = await signUp(ownerPublic, ownerName!);
  using collaboratorPublic = connect(harness.url);
  using collaborator = await signUp(collaboratorPublic, collaboratorName!);
  using ws = await owner.newWorkspace();
  const { id: workspaceId } = await ws.getMetadata();
  if (await ws.addCollaborator(collaboratorName!, "workspace") === null) {
    throw new Error("The collaborator was not added");
  }

  // The collaborator's turn, in the owner's workspace, is the owner's spend.
  using shared = await collaborator.openWorkspace(workspaceId);
  const chatId = await shared.newChat("Who pays for this?", SCRIPTED_MODEL_ID);
  await waitForIdleChat(shared, chatId);
  const ownerSummary = await summaryCounting(owner, CHAT_COST);

  expect(ownerSummary.workspaces.map(workspace => workspace.workspaceId)).toEqual([workspaceId]);
  expect((await collaborator.listWorkspaces()).map(workspace => workspace.id)).toContain(workspaceId);
  expect(await collaborator.getMyCostSummary()).toEqual(NOTHING);
});

it("deleting a workspace keeps its spend in deletedWorkspaces", async () => {
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("costdeleter")[0]!);
  using ws = await api.newWorkspace();

  const chatId = await ws.newChat("What will this have cost?", SCRIPTED_MODEL_ID);
  await waitForIdleChat(ws, chatId);
  const before = await summaryCounting(api, CHAT_COST);
  const [workspace] = before.workspaces;
  if (workspace === undefined) throw new Error("The summary listed no workspace");

  await ws.deleteSelf();
  const after = await waitFor("the workspace to leave the summary", async () => {
    const summary = await api.getMyCostSummary();
    return summary.workspaces.length === 0 ? summary : null;
  });
  expect(after).toEqual({
    ...before,
    workspaces: [],
    deletedWorkspaces: { totalCost: CHAT_COST, lines: workspace.lines },
  });
});
