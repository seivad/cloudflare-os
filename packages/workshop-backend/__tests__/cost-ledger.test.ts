import { describe, expect, it, vi } from "vitest";
import { env, RpcStub, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
  AUTO_ROUTER_MODEL_ID, type AiChatMetadata, type CostLine, type CostSource,
} from "@gadgets/workshop-shared/api";
import {
  actionCostEntry, addCost, byKind, byModel, costLineKey, isActionCost, isActionLog, mergeLines,
  textCostEntry,
  withEarlier, type CostAttribution, type CostEntry,
} from "../src/cost-ledger.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import {
  newPendingActionCost, type PendingActionCost,
} from "../src/storage-schema/overseer-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const KIMI = "@cf/moonshotai/kimi-k2.6";
const OPUS = "claude-opus-5-5";

function entry(overrides: Partial<CostEntry & { source: CostSource }> = {})
    : CostEntry & { source: CostSource } {
  return { source: "chat", kind: "text", model: KIMI, estimated: false, usd: 0.5, ...overrides };
}

describe("cost ledger", () => {
  it("addCost merges same kind/model/answeredBy/estimated and counts requests", () => {
    let lines = addCost([], entry({ usd: 0.5, inputTokens: 100, outputTokens: 10 }));
    lines = addCost(lines, entry({ usd: 0.25, inputTokens: 50, outputTokens: 5 }));
    lines = addCost(lines, entry({ model: OPUS, usd: 2 }));
    lines = addCost(lines, entry({ model: "auto", answeredBy: OPUS, usd: 1 }));
    lines = addCost(lines, entry({ model: "auto", answeredBy: KIMI, usd: 0.125 }));

    expect(lines).toEqual([
      { source: "chat", kind: "text", model: KIMI, estimated: false, usd: 0.75, requests: 2,
        inputTokens: 150, outputTokens: 15 },
      { source: "chat", kind: "text", model: OPUS, estimated: false, usd: 2, requests: 1 },
      { source: "chat", kind: "text", model: "auto", answeredBy: OPUS, estimated: false, usd: 1, requests: 1 },
      { source: "chat", kind: "text", model: "auto", answeredBy: KIMI, estimated: false, usd: 0.125, requests: 1 },
    ]);
  });

  it("addCost keeps each source's lines apart", () => {
    let lines = addCost([], entry({ usd: 0.5 }));
    lines = addCost(lines, entry({ source: "title", usd: 0.25 }));
    lines = addCost(lines, entry({ source: "model-binding", usd: 0.125 }));
    lines = addCost(lines, entry({ usd: 0.5 }));

    expect(lines).toEqual([
      { source: "chat", kind: "text", model: KIMI, estimated: false, usd: 1, requests: 2 },
      { source: "title", kind: "text", model: KIMI, estimated: false, usd: 0.25, requests: 1 },
      { source: "model-binding", kind: "text", model: KIMI, estimated: false, usd: 0.125,
        requests: 1 },
    ]);
    expect(new Set(lines.map(costLineKey)).size).toBe(3);
  });

  it("addCost keeps estimated and logged lines apart", () => {
    let lines = addCost([], entry({ usd: 0.5 }));
    lines = addCost(lines, entry({ estimated: true, usd: 0.25 }));
    lines = addCost(lines, entry({ kind: "image", estimated: true, usd: 0.25 }));

    expect(lines).toEqual([
      { source: "chat", kind: "text", model: KIMI, estimated: false, usd: 0.5, requests: 1 },
      { source: "chat", kind: "text", model: KIMI, estimated: true, usd: 0.25, requests: 1 },
      { source: "chat", kind: "image", model: KIMI, estimated: true, usd: 0.25, requests: 1 },
    ]);
    expect(new Set(lines.map(costLineKey)).size).toBe(3);
  });

  it("withEarlier adds the pre-breakdown remainder as text/earlier", () => {
    let lines = addCost([], entry({ usd: 0.5 }));
    expect(withEarlier(2.75, lines)).toEqual([
      ...lines,
      { source: "chat", kind: "text", model: "earlier", estimated: false, usd: 2.25, requests: 0 },
    ]);
  });

  it("withEarlier adds nothing when lines cover the total", () => {
    // The total is summed request by request and the lines line by line, and each addition
    // rounds, so the two can differ by far less than a cent.
    let lines = addCost(addCost(addCost([], entry({ usd: 0.1 })), entry({ model: OPUS, usd: 0.1 })),
        entry({ usd: 0.6 }));
    let total = 0.1 + 0.1 + 0.6;
    expect(total).toBeGreaterThan(lines.reduce((sum, line) => sum + line.usd, 0));
    expect(withEarlier(total, lines)).toEqual(lines);
    // Just under the threshold is rounding; just over it is a remainder.
    expect(withEarlier(1 + 0.0000009, [{ ...lines[0]!, usd: 1 }])).toHaveLength(1);
    expect(withEarlier(1 + 0.0000011, [{ ...lines[0]!, usd: 1 }])).toHaveLength(2);
    expect(withEarlier(0, [])).toEqual([]);
  });

  it("byModel groups auto's answering models under auto", () => {
    let lines = addCost([], entry({ model: "auto", answeredBy: OPUS, usd: 1 }));
    lines = addCost(lines, entry({ model: "auto", answeredBy: KIMI, usd: 0.25 }));
    lines = addCost(lines, entry({ model: "auto", estimated: true, usd: 0.25 }));
    lines = addCost(lines, entry({ model: OPUS, usd: 2 }));
    lines = addCost(lines, entry({ kind: "video", model: "veo", estimated: true, usd: 3 }));

    expect(byModel(lines)).toEqual({ auto: 1.5, [OPUS]: 2, veo: 3 });
    expect(byKind(lines)).toEqual({ text: 3.5, video: 3 });
  });

  it("mergeLines adds lines with the same key and keeps the others", () => {
    let a: CostLine[] = addCost(addCost([], entry({ usd: 1, inputTokens: 10 })),
        entry({ model: OPUS, usd: 2 }));
    let b: CostLine[] = addCost(addCost([], entry({ usd: 0.5, outputTokens: 4 })),
        entry({ kind: "speech", model: "aura", estimated: true, usd: 0.25 }));

    expect(mergeLines(a, b)).toEqual([
      { source: "chat", kind: "text", model: KIMI, estimated: false, usd: 1.5, requests: 2,
        inputTokens: 10, outputTokens: 4 },
      { source: "chat", kind: "text", model: OPUS, estimated: false, usd: 2, requests: 1 },
      { source: "chat", kind: "speech", model: "aura", estimated: true, usd: 0.25, requests: 1 },
    ]);
    // Neither input is changed.
    expect(a[0]?.usd).toBe(1);
    expect(b[0]?.usd).toBe(0.5);
  });
});

describe("a text request's cost", () => {
  // 100 prompt tokens (60 of them read from or written to the cache) and 10 response tokens,
  // which the catalog prices at a tenth of a cent.
  const usage: Usage = {
    input: 40, output: 10, cacheRead: 50, cacheWrite: 10, totalTokens: 110,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
  };

  it("is the gateway log's, with its answering model and tokens, in place of the estimate", () => {
    expect(textCostEntry({ model: AUTO_ROUTER_MODEL_ID, answeredBy: KIMI, usage },
        { cost: 0.5, model: OPUS, tokensIn: 120, tokensOut: 12 })).toEqual(
        { kind: "text", model: AUTO_ROUTER_MODEL_ID, answeredBy: OPUS, estimated: false, usd: 0.5,
          inputTokens: 120, outputTokens: 12 });
    // A log that names the picked model, and counts no tokens.
    expect(textCostEntry({ model: KIMI, usage }, { cost: 0.5, model: KIMI })).toEqual(
        { kind: "text", model: KIMI, estimated: false, usd: 0.5,
          inputTokens: 100, outputTokens: 10 });
  });

  it("names the model that answered only for the Auto Router", () => {
    // The gateway may spell a model it was asked for by name otherwise than the catalog does.
    const entry = textCostEntry({ model: KIMI, answeredBy: "workers-ai/kimi", usage },
        { cost: 0.5, model: "kimi-k2.6" });
    expect(entry).toMatchObject({ model: KIMI, usd: 0.5 });
    expect(entry?.answeredBy).toBeUndefined();
    expect(textCostEntry({ model: KIMI, answeredBy: OPUS, usage }, undefined)?.answeredBy)
        .toBeUndefined();
  });

  it("is the estimate where there is no log, or it gives no cost", () => {
    const estimate = { kind: "text", model: AUTO_ROUTER_MODEL_ID, answeredBy: KIMI,
      estimated: true, usd: 0.001, inputTokens: 100, outputTokens: 10 };
    expect(textCostEntry({ model: AUTO_ROUTER_MODEL_ID, answeredBy: KIMI, usage }, undefined))
        .toEqual(estimate);
    expect(textCostEntry({ model: AUTO_ROUTER_MODEL_ID, usage }, { cost: 0, model: KIMI }))
        .toEqual(estimate);
    expect(textCostEntry({ model: KIMI }, undefined)).toBeUndefined();
    expect(textCostEntry({ model: KIMI, usage: { ...usage, cost: { ...usage.cost, total: 0 } } },
        { cost: 0 })).toBeUndefined();
  });
});

// The OverseerImpl members this test drives; the class itself is private to overseer.ts.
interface OverseerInternals {
  storage: {
    chatMeta: { get(id: number): AiChatMetadata | undefined, put(meta: AiChatMetadata): void };
    totalCost: { get(): number, put(cost: number): void };
  };
  recordCost(entry: CostEntry & CostAttribution): void;
  getCostLines(): CostLine[];
}

describe("a workspace's cost ledger", () => {
  it("counts each cost to its total, its source's line and its chat, and shows the total from " +
      "before as earlier", async () => {
    const stub = env.TEST_OVERSEER.getByName("cost-ledger");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: OverseerInternals }).impl;
      impl.storage.totalCost.put(2);
      impl.storage.chatMeta.put(
          { id: 3, title: "Chat", started: new Date(0), lastActive: new Date(0) });

      impl.recordCost({ ...entry({ usd: 1.25 }), source: "chat", chatId: 3, isActivity: false });
      impl.recordCost({ ...entry({ usd: 0.25 }), source: "title", chatId: 3, isActivity: true });
      // A chat deleted before its cost arrived: the workspace paid for it all the same.
      impl.recordCost(
          { ...entry({ model: OPUS, estimated: true, usd: 0.5 }), source: "compaction",
            chatId: 4, isActivity: true });

      expect(impl.storage.totalCost.get()).toBe(4);
      const chat = impl.storage.chatMeta.get(3);
      expect(chat?.totalCost).toBe(1.5);
      expect(chat?.lastActive.valueOf()).toBeGreaterThan(0);
      expect(impl.storage.chatMeta.get(4)).toBeUndefined();
      expect(impl.getCostLines()).toEqual([
        { source: "chat", kind: "text", model: KIMI, estimated: false, usd: 1.25, requests: 1 },
        { source: "compaction", kind: "text", model: OPUS, estimated: true, usd: 0.5, requests: 1 },
        { source: "title", kind: "text", model: KIMI, estimated: false, usd: 0.25, requests: 1 },
        { source: "chat", kind: "text", model: "earlier", estimated: false, usd: 2, requests: 0 },
      ]);
    });
  });
});

// More of the OverseerImpl, for reaching an approval queue the way a Gatekeeper's session does.
interface GatekeeperSessions {
  storage: { gatekeepers: { put(record: unknown): void } };
  openGatekeeperSession(id: number, facet: unknown, caller: unknown): Promise<unknown>;
  getCostLines(): CostLine[];
}

describe("a model binding's cost report", () => {
  // The approval queue the session of a gatekeeper created as `creationSpec` is given.
  async function queueOf(impl: GatekeeperSessions, id: number, creationSpec: unknown) {
    impl.storage.gatekeepers.put({ id, class: {}, creationSpec });
    const facet = { startSession: async (queue: unknown) => queue };
    return await impl.openGatekeeperSession(id, facet, { from: "gadget" }) as
        { reportCost(cost: unknown): Promise<void> };
  }

  it("counts a model binding's request to its workspace", async () => {
    const stub = env.TEST_OVERSEER.getByName("model-binding-cost");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: GatekeeperSessions }).impl;
      const queue = await queueOf(impl, 1,
          { type: "aiModel", modelId: "m", provider: "anthropic", modelName: OPUS });
      await queue.reportCost({ model: OPUS, estimateUsd: 0.25, inputTokens: 100, outputTokens: 10 });
      // A report that names no log id, and has no gateway to read one from, counts as its estimate.
      await queue.reportCost({ model: OPUS, gatewayLogId: "log-1", estimateUsd: 0.25 });
      expect(impl.getCostLines()).toEqual([
        { source: "model-binding", kind: "text", model: OPUS, estimated: true, usd: 0.5, requests: 2,
          inputTokens: 100, outputTokens: 10 },
      ]);
    });
  });

  it("is refused for a gatekeeper that is not a model binding", async () => {
    const stub = env.TEST_OVERSEER.getByName("other-gatekeeper-cost");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: GatekeeperSessions }).impl;
      for (const [id, creationSpec] of [
        [1, { type: "gatekeeper", vendorId: "google", typeUrlPattern: "https://*" }],
        [2, { type: "modelCatalog" }],
        [3, undefined],
      ] as const) {
        const queue = await queueOf(impl, id, creationSpec);
        await expect(queue.reportCost({ model: OPUS, estimateUsd: 4 })).rejects.toThrow(
            "Only model bindings report costs this way.");
      }
      expect(impl.getCostLines()).toEqual([]);
    });
  });
});

// More of the OverseerImpl, for polling an approved action's cost with its Gatekeeper faked.
interface ActionCostPolling {
  storage: {
    gatekeepers: { put(record: unknown): void };
    pendingActionCosts: {
      put(record: PendingActionCost): void;
      list(): Iterable<PendingActionCost>;
    };
    countedCostLogs: {
      put(record: { logId: string; countedAt: number }): void;
      list(): Iterable<{ logId: string; countedAt: number }>;
    };
  };
  getGatekeeperFacet: (id: number) => Promise<unknown>;
  pollActionCosts(answerTimeoutMs?: number): Promise<void>;
  getCostLines(): CostLine[];
}

describe("an approved action's cost", () => {
  // `impl` with gatekeeper 1 answering through `facet`, and its action 3 (record 7) due now,
  // queued at `queuedAt`.
  function queue(impl: ActionCostPolling, facet: object, queuedAt = Date.now()) {
    impl.storage.gatekeepers.put({ id: 1, class: {} });
    impl.storage.pendingActionCosts.put(
        newPendingActionCost({ id: 7, gatekeeperId: 1, action: 3 }, queuedAt, Date.now()));
    impl.getGatekeeperFacet = async () => facet;
  }

  it("is dropped at once when the gatekeeper has no getActionCost", async () => {
    const stub = env.TEST_OVERSEER.getByName("action-cost-no-method");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: ActionCostPolling }).impl;
      // Workers RPC's own refusal of a method the receiver lacks.
      queue(impl, new RpcStub(new RpcTarget()));
      await impl.pollActionCosts();
      expect([...impl.storage.pendingActionCosts.list()]).toEqual([]);
    });
  });

  it("is asked for again, later, after any other failure", async () => {
    const stub = env.TEST_OVERSEER.getByName("action-cost-failure");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: ActionCostPolling }).impl;
      queue(impl, { getActionCost: async () => { throw new Error("The studio is down."); } });
      const before = Date.now();
      await impl.pollActionCosts();
      const [pending] = [...impl.storage.pendingActionCosts.list()];
      expect(pending).toMatchObject({ actionRecordId: 7, attempts: 1, logAttempts: 0 });
      expect(pending!.nextPollAt).toBeGreaterThanOrEqual(before + 60_000);
    });
  });

  it("is asked for again, later, when the gatekeeper doesn't answer in time", async () => {
    const stub = env.TEST_OVERSEER.getByName("action-cost-timeout");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: ActionCostPolling }).impl;
      queue(impl, { getActionCost: () => new Promise(() => {}) });
      await impl.pollActionCosts(50);
      expect([...impl.storage.pendingActionCosts.list()])
          .toMatchObject([{ actionRecordId: 7, attempts: 1 }]);
    });
  });

  it("is asked for again, later, when the gatekeeper's facet can't be reached in time", async () => {
    const stub = env.TEST_OVERSEER.getByName("action-cost-facet-timeout");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: ActionCostPolling }).impl;
      queue(impl, {});
      impl.getGatekeeperFacet = () => new Promise(() => {});
      await impl.pollActionCosts(50);
      expect([...impl.storage.pendingActionCosts.list()])
          .toMatchObject([{ actionRecordId: 7, attempts: 1 }]);
    });
  });

  it("is dropped on a malformed answer", async () => {
    const stub = env.TEST_OVERSEER.getByName("action-cost-malformed");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: ActionCostPolling }).impl;
      queue(impl, { getActionCost: async () => ({ state: "spent", kind: "video", model: "m",
        estimateUsd: -1 }) });
      await impl.pollActionCosts();
      expect([...impl.storage.pendingActionCosts.list()]).toEqual([]);
      expect(impl.getCostLines()).toEqual([]);
    });
  });

  it("forgets counted logs once they are past the age a log is refused at", async () => {
    const stub = env.TEST_OVERSEER.getByName("action-cost-prune");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: ActionCostPolling }).impl;
      const DAY = 24 * 60 * 60 * 1000;
      impl.storage.countedCostLogs.put({ logId: "old", countedAt: Date.now() - 32 * DAY });
      impl.storage.countedCostLogs.put({ logId: "recent", countedAt: Date.now() - 30 * DAY });
      await impl.pollActionCosts();
      expect([...impl.storage.countedCostLogs.list()].map(row => row.logId)).toEqual(["recent"]);
    });
  });

  it("is given up on a week after it was queued", async () => {
    const stub = env.TEST_OVERSEER.getByName("action-cost-give-up");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: ActionCostPolling }).impl;
      const getActionCost = vi.fn(async () => ({ state: "pending" }));
      queue(impl, { getActionCost }, Date.now() - 7 * 24 * 60 * 60 * 1000 - 1);
      await impl.pollActionCosts();
      expect(getActionCost).not.toHaveBeenCalled();
      expect([...impl.storage.pendingActionCosts.list()]).toEqual([]);
    });
  });
});

describe("what an approved action that spent counts as", () => {
  const NOW = Date.UTC(2026, 10, 21);
  const DAY = 24 * 60 * 60 * 1000;
  const SPENT = { state: "spent", kind: "video", model: "google/veo-3", estimateUsd: 9 } as const;
  const ESTIMATE = { kind: "video", model: "google/veo-3", estimated: true, usd: 5 };
  const log = (overrides: object = {}) => ({
    cost: 0.94, model: "google/veo-3", metadata: { tag: "mine" }, createdAt: new Date(NOW - DAY),
    ...overrides,
  });

  it("is its log's cost, answered by the model the log names only for the Auto Router", () => {
    expect(actionCostEntry(SPENT, log({ model: "google/veo-3-fast", tokensOut: 10 }), "mine", NOW))
        .toEqual({ kind: "video", model: "google/veo-3", estimated: false, usd: 0.94,
          outputTokens: 10 });
    expect(actionCostEntry(SPENT, log(), "mine", NOW))
        .toEqual({ kind: "video", model: "google/veo-3", estimated: false, usd: 0.94 });
    expect(actionCostEntry({ ...SPENT, kind: "text", model: AUTO_ROUTER_MODEL_ID },
        log({ model: OPUS }), "mine", NOW)).toEqual({ kind: "text", model: AUTO_ROUTER_MODEL_ID,
      answeredBy: OPUS, estimated: false, usd: 0.94 });
  });

  it("is the capped estimate for a log over 31 days old, or of unknown age", () => {
    expect(actionCostEntry(SPENT, log({ createdAt: new Date(NOW - 32 * DAY) }), "mine", NOW))
        .toEqual(ESTIMATE);
    expect(actionCostEntry(SPENT, log({ createdAt: undefined }), "mine", NOW)).toEqual(ESTIMATE);
  });

  it("is the capped estimate for its own recent log when the log gives no cost", () => {
    expect(actionCostEntry(SPENT, log({ cost: 0 }), "mine", NOW)).toEqual(ESTIMATE);
    expect(isActionLog(log({ cost: 0 }), "mine", NOW)).toBe(true);
  });

  it("is counted from a log that is this gatekeeper's and recent", () => {
    expect(isActionLog(log(), "mine", NOW)).toBe(true);
    expect(isActionLog(log({ metadata: { tag: "theirs" } }), "mine", NOW)).toBe(false);
    expect(isActionLog(log({ metadata: {} }), undefined, NOW)).toBe(false);
    expect(isActionLog(log({ createdAt: new Date(NOW - 32 * DAY) }), "mine", NOW)).toBe(false);
    expect(isActionLog(undefined, "mine", NOW)).toBe(false);
  });

  it("is the capped estimate with no log, or an untagged one", () => {
    expect(actionCostEntry(SPENT, undefined, "mine", NOW)).toEqual(ESTIMATE);
    expect(actionCostEntry(SPENT, log({ metadata: {} }), "mine", NOW)).toEqual(ESTIMATE);
    expect(actionCostEntry(SPENT, log({ metadata: undefined }), undefined, NOW)).toEqual(ESTIMATE);
  });

  it("is nothing for a log with another tag, including when the gatekeeper was given none", () => {
    expect(actionCostEntry(SPENT, log({ metadata: { tag: "theirs" } }), "mine", NOW)).toBeNull();
    expect(actionCostEntry(SPENT, log(), undefined, NOW)).toBeNull();
  });

  it("is only ever counted from a well-formed answer", () => {
    expect(isActionCost({ state: "pending" })).toBe(true);
    expect(isActionCost(SPENT)).toBe(true);
    expect(isActionCost({ ...SPENT, kind: "hologram" })).toBe(false);
    expect(isActionCost({ ...SPENT, estimateUsd: Number.NaN })).toBe(false);
    expect(isActionCost({ ...SPENT, gatewayLogId: 7 })).toBe(false);
    expect(isActionCost(null)).toBe(false);
  });
});
