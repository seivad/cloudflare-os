import { describe, expect, it, vi } from "vitest";
import { SUGGESTED_MODELS } from "@gadgets/workshop-shared/api";
import { AiGatewayConfig, GatewayModels } from "../src/ai-gateway.js";
import { DEFAULT_ADMIN_CONFIG } from "../src/storage-schema/admin-settings-storage.js";
import {
  listGatewayProviderModels, listGatewayProviderModelsForUser, parseAnthropic, parseOpenAi,
  parseOpenRouter, parseWorkersAi,
} from "../src/gateway-provider-models.js";

const OPENROUTER_LIST = {
  data: [
    {
      id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", context_length: 1048576,
      supported_parameters: ["tools", "reasoning"],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.0000014", completion: "0.0000044" },
      top_provider: { max_completion_tokens: 131072 },
    },
    // An alias, a batch model, one with no tools, one that draws, and a router priced -1.
    { id: "~z-ai/glm-latest", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" } },
    { id: "z-ai/glm-5.3:batch", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" } },
    { id: "acme/plain", supported_parameters: [], pricing: { prompt: "0", completion: "0" } },
    {
      id: "acme/painter", supported_parameters: ["tools"],
      architecture: { output_modalities: ["image"] }, pricing: { prompt: "0", completion: "0" },
    },
    { id: "openrouter/auto", supported_parameters: ["tools"], pricing: { prompt: "-1", completion: "-1" } },
    {
      id: "acme/seeing", name: "Acme Seeing", supported_parameters: ["tools"],
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: { prompt: "0.000001", completion: "0.000002" },
    },
  ],
};

describe("model list parsers", () => {
  it("keeps OpenRouter's priced, tool-calling text models, with what each states", () => {
    expect(parseOpenRouter(OPENROUTER_LIST)).toEqual([
      {
        provider: "openrouter", id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", contextWindow: 1048576,
        outputLimit: 131072, capabilities: { imageInput: false, reasoningLevels: ["low", "medium", "high"] },
        price: { input: 1.4, output: 4.4 },
      },
      {
        provider: "openrouter", id: "acme/seeing", name: "Acme Seeing",
        capabilities: { imageInput: true }, price: { input: 1, output: 2 },
      },
    ]);
    expect(parseOpenRouter("not a list")).toEqual([]);
  });

  it("keeps Anthropic's active models across pages, and OpenAI's chat models by name", () => {
    expect(parseAnthropic([
      { data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 1000000 }] },
      { data: [{ id: "claude-old", lifecycle: "deprecated" }, { id: "claude-next" }] },
    ])).toEqual([
      { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 1000000 },
      { provider: "anthropic", id: "claude-next", name: "claude-next" },
    ]);
    expect(parseOpenAi({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-image" }, { id: "text-embedding-4" }, { id: "o5" }] }))
        .toEqual([
          { provider: "openai", id: "gpt-6.1-sol", name: "gpt-6.1-sol" },
          { provider: "openai", id: "o5", name: "o5" },
        ]);
  });

  it("keeps Workers AI's function-calling text models, with price, window and plan rate", () => {
    expect(parseWorkersAi([
      {
        name: "@cf/zai-org/glm-5.3", task: { name: "Text Generation" }, properties: [
          { property_id: "function_calling", value: "true" },
          { property_id: "context_window", value: "1048576" },
          { property_id: "require_workers_paid", value: "true" },
          { property_id: "price", value: JSON.stringify([
            { unit: "per M input tokens", price: 1.4 }, { unit: "per M output tokens", price: 4.4 },
            { unit: "per M cached input tokens", price: 0.26 },
          ]) },
        ],
      },
      {
        name: "@cf/qwen/qwen3.8-27b", task: { name: "Text Generation" },
        properties: [{ property_id: "function_calling", value: "true" }],
      },
      { name: "@cf/acme/no-tools", task: { name: "Text Generation" }, properties: [] },
      { name: "@cf/acme/voice", task: { name: "Text-to-Speech" }, properties: [{ property_id: "function_calling", value: "true" }] },
    ])).toEqual([
      {
        provider: "cloudflare", id: "@cf/zai-org/glm-5.3", name: "glm-5.3", contextWindow: 1048576,
        price: { input: 1.4, output: 4.4 }, rateLimit: 20,
      },
      { provider: "cloudflare", id: "@cf/qwen/qwen3.8-27b", name: "qwen3.8-27b", rateLimit: 300 },
    ]);
  });
});

describe("listGatewayProviderModels", () => {
  // A gateway whose binding answers each list path with `answer(path)`.
  const gateway = (name: string, answer: (path: string) => Response) => {
    const binding = {
      fetch: vi.fn(async (url: string) =>
          answer(url.replace(`https://workers-binding.ai/ai-gateway/gateways/${name}/`, ""))),
    } as unknown as Ai;
    return {
      binding,
      config: new AiGatewayConfig({
        CF_AI_GATEWAY: name, CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
        CF_AI_GATEWAY_PROVIDERS: "cloudflare", WORKERS_AI: binding,
      } as unknown as Cloudflare.Env),
    };
  };

  it("reads OpenRouter's list once in ten minutes, filling in the runtime's facts", async () => {
    const { binding, config } = gateway("list-a", path =>
        path === "openrouter/v1/models" ? Response.json(OPENROUTER_LIST) : new Response("", { status: 404 }));
    const listing = await listGatewayProviderModels(config, "openrouter", 0);
    expect(listing.state).toBe("ready");
    expect(listing.models.map(model => model.id)).toEqual(["z-ai/glm-5.3", "acme/seeing"]);
    await listGatewayProviderModels(config, "openrouter", 9 * 60_000);
    expect(binding.fetch).toHaveBeenCalledTimes(1);
    // A GET with no body: no prompt goes out, and it is not logged as inference.
    const [, init] = (binding.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers["cf-aig-collect-log"]).toBe("false");
    await listGatewayProviderModels(config, "openrouter", 10 * 60_000);
    expect(binding.fetch).toHaveBeenCalledTimes(2);
  });

  it("says a provider whose key is refused is not connected, and keeps a list through an outage", async () => {
    let status = 401;
    const { config } = gateway("list-b", path => path === "openai/models" && status === 200
        ? Response.json({ data: [{ id: "gpt-6.1-sol" }] })
        : new Response("", { status }));
    const refused = await listGatewayProviderModels(config, "openai", 0);
    expect(refused).toMatchObject({ provider: "openai", state: "not-connected", models: [] });
    expect(refused.note).toContain("Provider Keys");
    status = 200;
    const read = await listGatewayProviderModels(config, "openai", 60_000);
    // OpenAI's list says nothing of a model; the runtime's catalog gives its window and price.
    expect(read.models).toEqual([expect.objectContaining({
      id: "gpt-6.1-sol", contextWindow: expect.any(Number), price: expect.any(Object),
    })]);
    status = 503;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await listGatewayProviderModels(config, "openai", 11 * 60_000)).toEqual(read);
    quiet.mockRestore();
  });

  it("gives Bedrock's suggested set, and refuses a provider the gateway does not serve", async () => {
    const { binding, config } = gateway("list-c", () => new Response("", { status: 500 }));
    const listing = await listGatewayProviderModels(config, "aws-bedrock", 0);
    expect(listing.state).toBe("ready");
    expect(listing.models.map(model => model.id)).toEqual(Object.keys(SUGGESTED_MODELS["aws-bedrock"]));
    expect(listing.models[0]!.price).toBeDefined();
    expect(binding.fetch).not.toHaveBeenCalled();
    await expect(listGatewayProviderModels(config, "ollama", 0))
        .rejects.toThrow('Provider "ollama" is not served through AI Gateway.');
  });
});

describe("listGatewayProviderModelsForUser", () => {
  const config = new AiGatewayConfig({
    CF_AI_GATEWAY: "list-user", CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
    CF_AI_GATEWAY_PROVIDERS: "cloudflare,aws-bedrock", WORKERS_AI: { fetch: vi.fn() },
  } as unknown as Cloudflare.Env);
  const models = (userModelsEnabled: boolean) =>
      new GatewayModels(config, { ...DEFAULT_ADMIN_CONFIG, userModelsEnabled }, new Set());

  it("lists only what the user could add: in gateway mode, with own models on, under a provider on", async () => {
    await expect(listGatewayProviderModelsForUser(null, "aws-bedrock"))
        .rejects.toThrow("does not provide models through AI Gateway");
    await expect(listGatewayProviderModelsForUser(models(false), "aws-bedrock"))
        .rejects.toThrow("Adding your own models is disabled");
    await expect(listGatewayProviderModelsForUser(models(true), "openrouter"))
        .rejects.toThrow('Provider "openrouter" is not available on this deployment.');
    expect((await listGatewayProviderModelsForUser(models(true), "aws-bedrock")).state).toBe("ready");
  });
});
