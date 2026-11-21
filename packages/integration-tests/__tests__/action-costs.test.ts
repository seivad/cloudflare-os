import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, UserCostSummary } from "@gadgets/workshop-shared/api";
import type { ActionCost } from "@gadgets/workshop-shared/gatekeeper";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testControl, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, waitFor,
} from "../src/rpc-client.js";

const LOGS_URL = "https://api.cloudflare.com/client/v4/accounts/gateway-account-id/ai-gateway/gateways/" +
    "platform-gateway/logs/";
// What the Workshop asks the gateway to learn which providers it holds a key for.
const KEY_CHECK_URLS = ["openai/models", "anthropic/v1/models?limit=1", "openrouter/v1/key"]
    .map(path => `https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/${path}`);
const VIDEO = { kind: "video", model: "google/veo-3" } as const;
// A line of approved actions' videos.
const VIDEO_LINE = { source: "action", ...VIDEO } as const;

/** A video that spent `estimateUsd` by its Gatekeeper's estimate, logged as `gatewayLogId`. */
function spentVideo(gatewayLogId: string, estimateUsd = 2): ActionCost {
  return { state: "spent", ...VIDEO, estimateUsd, gatewayLogId };
}

// The gateway's logs, by id, as each test sets them: an id with none is not found. Every read of
// one is counted.
const logs = new Map<string, object>();
const logReads = new Map<string, number>();
const network = new NetworkInterceptor({
  handlers: [async (url, method) => {
    if (method === "GET" && url.href.startsWith(LOGS_URL)) {
      const logId = url.href.slice(LOGS_URL.length);
      logReads.set(logId, (logReads.get(logId) ?? 0) + 1);
      const log = logs.get(logId);
      return log
        ? Response.json({ success: true, result: log })
        : new Response("not found", { status: 404 });
    }
    // The gateway holds no key for any provider it is asked about.
    if (method === "GET" && KEY_CHECK_URLS.includes(url.href)) {
      return new Response("no key", { status: 401 });
    }
    return null;
  }],
});
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({
    // The HTTPS transport reads the log with a plain fetch the interceptor answers. Polls start
    // 50 ms after approval rather than 30 s, so a test sees several in a few seconds.
    patchWorkshop: config => {
      config.vars = {
        ...config.vars,
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
        CF_AI_GATEWAY_API_TOKEN: "read-run-token",
        CF_AI_GATEWAY_USE_BINDING: "false",
        CF_AI_GATEWAY_PROVIDERS: "cloudflare",
        ACTION_COST_FIRST_POLL_MS: "50",
      };
    },
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A fresh user's workspace, with their test account, to bind Test Things into. */
async function testWorkspace(prefix: string) {
  const stack = new DisposableStack();
  const [name] = nextUsernames(prefix);
  const api = stack.use(await signUp(stack.use(connect(harness.url)), name!));
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the test account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  const ws = stack.use(await api.newWorkspace());

  /** A session on a new binding: a spending one unless `plain`. */
  async function bind(plain = false) {
    const resourceUrl = `https://gadgets-test.example/things/${plain ? "plain" : "spending"}-` +
        `${name}-${crypto.randomUUID()}`;
    const gatekeeper = await ws.newGatekeeper(account.id, resourceUrl);
    if (!gatekeeper) throw new Error("Failed to create the test connection");
    stack.use(gatekeeper);
    const session = stack.use(await gatekeeper.openSession() as RpcStub<TestSession>);
    return { session, resourceUrl };
  }
  return Object.assign(stack, { api, ws, label: accountLabel(account), bind });
}

/** Writes `value` as a spending action, answering getActionCost() with `cost` once approved. */
async function spend(
    workspace: { label: string }, session: RpcStub<TestSession>, value: number, cost?: ActionCost)
    : Promise<number> {
  const action = await session.writeValue(value, { reportsCost: true });
  if (cost) await setActionCost(workspace.label, action, cost);
  return action;
}

function setActionCost(label: string, action: number, cost: ActionCost): Promise<void> {
  return testControl(harness, "action-cost", { label, action, cost });
}

async function polls(label: string, action: number): Promise<number> {
  return (await testControl<{ polls: number }>(harness, "action-cost-polls", { label, action }))
      .polls;
}

async function costTag(resourceUrl: string): Promise<string> {
  const { tag } = await testControl<{ tag: string | null }>(harness, "cost-tag", { resourceUrl });
  if (tag === null) throw new Error("The binding was given no cost tag");
  return tag;
}

/** Approves (or rejects) the pending write of `value`. */
async function decide(ws: RpcStub<Overseer>, value: number, approve = true): Promise<void> {
  const { entries } = await ws.listActions({ filter: "pending" });
  const write = entries.find(e => e.description.title === `Set the test value to ${value}`);
  if (!write) throw new Error(`No pending write of ${value}`);
  await (approve ? ws.approveAction(write.id) : ws.rejectAction(write.id));
}

/** The caller's summary, once it counts `total`. */
function summaryCounting(api: RpcStub<AuthenticatedApi>, total: number): Promise<UserCostSummary> {
  return waitFor(`a summary counting ${total}`, async () => {
    const summary = await api.getMyCostSummary();
    return summary.totalCost === total ? summary : null;
  });
}

/** A log AI Gateway made a minute ago, of a request whose metadata was `metadata`. */
function setLog(logId: string, metadata: object) {
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  logs.set(logId, { cost: 0.94, model: "google/veo-3", metadata, created_at: createdAt });
}

/** A log of this connection's, as AI Gateway records a request made with its tag. */
async function logFor(resourceUrl: string, logId: string) {
  setLog(logId, { tag: await costTag(resourceUrl) });
}

it("an approved spending action is counted from its gateway log", async () => {
  using workspace = await testWorkspace("actioncost");
  const { session, resourceUrl } = await workspace.bind();
  const logId = crypto.randomUUID();
  await spend(workspace, session, 1, spentVideo(logId));
  await logFor(resourceUrl, logId);

  await decide(workspace.ws, 1);
  const summary = await summaryCounting(workspace.api, 0.94);
  expect(summary.workspaces[0]!.lines).toEqual(
      [{ ...VIDEO_LINE, estimated: false, usd: 0.94, requests: 1 }]);
});

it("a pending action is polled until it is spent", async () => {
  using workspace = await testWorkspace("actioncostpending");
  const { session, resourceUrl } = await workspace.bind();
  const action = await spend(workspace, session, 1);
  await decide(workspace.ws, 1);
  await waitFor("two polls", async () => await polls(workspace.label, action) >= 2 || null);

  const logId = crypto.randomUUID();
  await logFor(resourceUrl, logId);
  await setActionCost(workspace.label, action,
      spentVideo(logId));
  const summary = await summaryCounting(workspace.api, 0.94);
  expect(summary.workspaces[0]!.lines).toEqual(
      [{ ...VIDEO_LINE, estimated: false, usd: 0.94, requests: 1 }]);
});

it("the same log id reported by two actions is counted once", async () => {
  using workspace = await testWorkspace("actioncostreplay");
  const { session, resourceUrl } = await workspace.bind();
  const logId = crypto.randomUUID();
  const cost: ActionCost = spentVideo(logId);
  const first = await spend(workspace, session, 1, cost);
  const second = await spend(workspace, session, 2, cost);
  await logFor(resourceUrl, logId);

  await decide(workspace.ws, 1);
  await decide(workspace.ws, 2);
  await waitFor("both actions to be polled", async () =>
    await polls(workspace.label, first) > 0 && await polls(workspace.label, second) > 0 || null);
  await summaryCounting(workspace.api, 0.94);
  // Long enough for a second count to have reached the summary.
  await sleep(1_500);
  const summary = await workspace.api.getMyCostSummary();
  expect(summary.workspaces[0]!.lines).toEqual(
      [{ ...VIDEO_LINE, estimated: false, usd: 0.94, requests: 1 }]);
});

it("a log whose tag is not this gatekeeper's counts nothing", async () => {
  using workspace = await testWorkspace("actioncosttag");
  const { session } = await workspace.bind();
  const logId = crypto.randomUUID();
  setLog(logId, { tag: "another-gatekeepers" });
  const action = await spend(workspace, session, 1, spentVideo(logId, 9));

  await decide(workspace.ws, 1);
  await waitFor("a poll", async () => await polls(workspace.label, action) > 0 || null);
  // Long enough for a count to have reached the summary, or for more polls had it gone on.
  await sleep(1_500);
  expect(await polls(workspace.label, action)).toBe(1);
  expect((await workspace.api.getMyCostSummary()).totalCost).toBe(0);
});

it("an untagged log counts the capped estimate instead", async () => {
  using workspace = await testWorkspace("actioncostuntagged");
  const { session } = await workspace.bind();
  const logId = crypto.randomUUID();
  setLog(logId, {});
  await spend(workspace, session, 1, spentVideo(logId, 9));

  await decide(workspace.ws, 1);
  const summary = await summaryCounting(workspace.api, 5);
  expect(summary.workspaces[0]!.lines).toEqual(
      [{ ...VIDEO_LINE, estimated: true, usd: 5, requests: 1 }]);
});

it("falls back to the estimate once after the log stays unreadable", async () => {
  using workspace = await testWorkspace("actioncostunread");
  const { session, resourceUrl } = await workspace.bind();
  const logId = crypto.randomUUID();
  await spend(workspace, session, 1, spentVideo(logId, 0.5));

  await decide(workspace.ws, 1);
  const summary = await summaryCounting(workspace.api, 0.5);
  expect(summary.workspaces[0]!.lines).toEqual(
      [{ ...VIDEO_LINE, estimated: true, usd: 0.5, requests: 1 }]);
  expect(logReads.get(logId)).toBe(6);

  // The log counted at the estimate counts no more once it can be read, for any action.
  await logFor(resourceUrl, logId);
  const again = await spend(workspace, session, 2, spentVideo(logId, 0.5));
  await decide(workspace.ws, 2);
  await waitFor("the second action's poll", async () =>
    await polls(workspace.label, again) > 0 || null);
  await sleep(1_500);
  expect((await workspace.api.getMyCostSummary()).totalCost).toBe(0.5);
  expect(logReads.get(logId)).toBe(6);
});

it("none counts nothing and stops polling", async () => {
  using workspace = await testWorkspace("actioncostnone");
  const { session } = await workspace.bind();
  const action = await spend(workspace, session, 1, { state: "none" });

  await decide(workspace.ws, 1);
  await waitFor("a poll", async () => await polls(workspace.label, action) > 0 || null);
  // Long enough for several more polls, had it gone on.
  await sleep(1_500);
  expect(await polls(workspace.label, action)).toBe(1);
  expect((await workspace.api.getMyCostSummary()).totalCost).toBe(0);
});

it("drops a pending cost when the gatekeeper has no getActionCost", async () => {
  using workspace = await testWorkspace("actioncostold");
  const plain = await workspace.bind(true);
  await plain.session.writeValue(1, { reportsCost: true });
  await decide(workspace.ws, 1);

  // Polling goes on for the workspace's other actions, and counts only theirs.
  const { session, resourceUrl } = await workspace.bind();
  const logId = crypto.randomUUID();
  await spend(workspace, session, 2, spentVideo(logId));
  await logFor(resourceUrl, logId);
  await decide(workspace.ws, 2);
  const summary = await summaryCounting(workspace.api, 0.94);
  expect(summary.workspaces[0]!.lines).toEqual(
      [{ ...VIDEO_LINE, estimated: false, usd: 0.94, requests: 1 }]);
});

it("stops polling once the workspace is deleting", async () => {
  using workspace = await testWorkspace("actioncostdeleted");
  const { session } = await workspace.bind();
  const action = await spend(workspace, session, 1);
  await decide(workspace.ws, 1);
  await waitFor("a poll", async () => await polls(workspace.label, action) > 0 || null);

  await workspace.ws.deleteSelf();
  // A poll already under way when the deletion began may still land.
  await sleep(200);
  const before = await polls(workspace.label, action);
  await sleep(1_500);
  expect(await polls(workspace.label, action)).toBe(before);
});

it("a rejected action is never polled", async () => {
  using workspace = await testWorkspace("actioncostrejected");
  const { session, resourceUrl } = await workspace.bind();
  const rejected = await spend(workspace, session, 1);
  await decide(workspace.ws, 1, false);

  // An action approved after it is polled and counted, so the rejected one would have been too.
  const logId = crypto.randomUUID();
  await spend(workspace, session, 2, spentVideo(logId));
  await logFor(resourceUrl, logId);
  await decide(workspace.ws, 2);
  await summaryCounting(workspace.api, 0.94);
  expect(await polls(workspace.label, rejected)).toBe(0);
});

it("a gatekeeper that is not a model binding cannot report a cost", async () => {
  using workspace = await testWorkspace("actioncostreport");
  const { session } = await workspace.bind();
  await expect(session.reportCost()).rejects.toThrow("Only model bindings report costs this way.");
});
