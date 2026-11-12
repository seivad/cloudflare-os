import { describe, expect, it } from "vitest";
import { serializeAdminConfig } from "../src/admin-config.js";
import { DEFAULT_ADMIN_CONFIG, type AdminConfig } from "../src/storage-schema/admin-settings-storage.js";
import { ModelCatalogGatekeeper } from "../src/model-catalog.js";

// A deployment's catalog is read from its admin config on every call, so these tests drive the
// real GatewayModels through a stub KV holding that config.

const GATEWAY_ENV = {
  CF_AI_GATEWAY: "platform-gateway",
  CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
  CF_AI_GATEWAY_API_TOKEN: "gateway-token",
  CF_AI_GATEWAY_PROVIDERS: "anthropic,openai",
};

/** A catalog session on a deployment whose admin config is `admin()` at the time of each call. */
async function startCatalog(admin: () => Partial<AdminConfig> = () => ({}),
                            envOverrides: Record<string, unknown> = GATEWAY_ENV) {
  const gatekeeper = Object.create(ModelCatalogGatekeeper.prototype) as ModelCatalogGatekeeper;
  Object.assign(gatekeeper, {
    env: {
      ...envOverrides,
      BLUEPRINTS: {
        get: async () => serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, ...admin() }),
      } as unknown as KVNamespace,
    },
    ctx: { props: {} },
  });
  return gatekeeper.startSession(undefined as never);
}

describe("ModelCatalogGatekeeper", () => {
  it("lists the admin catalog in order", async () => {
    const catalog = await startCatalog(() => ({
      providerOrder: ["openai", "anthropic"],
      modelOrder: { anthropic: ["claude-sonnet-5-5", "claude-opus-5-5"] },
    }));
    const models = await catalog.list();
    expect(models.length).toBeGreaterThan(2);
    expect(models[0].provider).toBe("openai");
    const anthropic = models.filter(model => model.provider === "anthropic").map(m => m.id);
    expect(anthropic.slice(0, 2)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(models.findIndex(m => m.provider === "anthropic"))
        .toBeGreaterThan(models.findLastIndex(m => m.provider === "openai"));
    for (const model of models) {
      expect(model.name).toBeTruthy();
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });

  it("omits models the admin turned off", async () => {
    const all = await (await startCatalog()).list();
    const [off, hidden, ...rest] = all.map(model => model.id);
    const models = await (await startCatalog(() => ({
      modelModes: { [off]: "disabled", [hidden]: "hidden" },
    }))).list();
    expect(models.map(model => model.id)).toEqual(rest);
  });

  it("reflects an admin change without a redeploy", async () => {
    let admin: Partial<AdminConfig> = {};
    const catalog = await startCatalog(() => admin);
    const before = await catalog.list();
    admin = { modelModes: { [before[0].id]: "disabled" } };
    expect((await catalog.list()).map(model => model.id))
        .toEqual(before.slice(1).map(model => model.id));
  });

  it("returns no fields beyond CatalogModel", async () => {
    const models = await (await startCatalog(() => ({
      modelSettings: { "claude-opus-5-5": { reasoning: "high" } },
      addedModels: [{ provider: "anthropic", id: "claude-added", name: "Added",
                      contextWindow: 123_000, outputLimit: 4_000, behavesLike: "claude-opus-5-5" }],
    }), { ...GATEWAY_ENV, CF_AI_GATEWAY_PROVIDERS: "cloudflare-auto-router,anthropic" })).list();
    const allowed = new Set(["id", "name", "provider", "contextWindow", "description"]);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(Object.keys(model).every(key => allowed.has(key))).toBe(true);
      for (const key of ["id", "name", "provider", "contextWindow"]) expect(model).toHaveProperty(key);
    }
    // Only a suggested model has a description, and an added one is described by name and limits.
    expect(models.find(model => model.id === "claude-added")).toEqual({
      id: "claude-added", name: "Added", provider: "anthropic", contextWindow: 123_000,
    });
    expect(models.find(model => model.provider === "cloudflare-auto-router")).toEqual({
      id: "cloudflare/auto", name: "Auto", provider: "cloudflare-auto-router", contextWindow: 128_000,
      description: "Best model for each request",
    });
  });

  it("empty list when AI Gateway mode is off", async () => {
    expect(await (await startCatalog(() => ({}), {})).list()).toEqual([]);
  });
});
