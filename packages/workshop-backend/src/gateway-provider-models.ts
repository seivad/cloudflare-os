import {
  AiModelProvider, GatewayModelCapabilities, GatewayProviderModel, GatewayProviderModels,
  SUGGESTED_MODELS,
} from "@gadgets/workshop-shared/api";
import { AiGatewayConfig, GatewayModels, assertGatewayProvider, gatewayProviderGet } from "./ai-gateway.js";
import { runtimeModelFacts } from "./ai-models.js";

// The models a provider lists through the deployment's AI Gateway, for a person adding a model to
// pick from rather than type: each provider's own list read through the gateway with the key it
// stores (OpenRouter's, Anthropic's, OpenAI's), Workers AI's from the account's catalog, and
// Bedrock's suggested set, which is all there is behind the gateway. Only reads: no prompt is sent.

/** How long a list read stands. */
const LIST_TTL_MS = 10 * 60_000;
/** How long a failed read stands before the next request tries again. */
const FAILED_TTL_MS = 60_000;
/** How long one read may take. */
const LIST_TIMEOUT_MS = 20_000;
/** Pages of Anthropic's list read at most, a thousand models a page. */
const MAX_PAGES = 5;
/** The longest ID or name kept, as the server accepts for an added model. */
const MAX_TEXT_LENGTH = 200;
/** What Workers AI's plans allow a model a minute: 20 for one that needs Workers Paid, else 300. */
const WORKERS_AI_RATES = { paid: 20, free: 300 } as const;

type Entry = { at: number; ttl: number; listing: GatewayProviderModels };

/** Each gateway's lists, by `<gateway>|<provider>`, and the reads in flight. */
const lists = new Map<string, Entry>();
const reading = new Map<string, Promise<GatewayProviderModels>>();

/** A read whose provider answered with `status`, or failed before any answer. */
class ListFailed extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The rows of a `{ data: [...] }` list, the objects among them. */
const rows = (json: unknown): Record<string, unknown>[] => {
  let data = isRecord(json) ? json.data : undefined;
  return Array.isArray(data) ? data.filter(isRecord) : [];
};

/** `value` as one line of text no longer than MAX_TEXT_LENGTH, or "" when it isn't text. */
const text = (value: unknown): string =>
  // oxlint-disable-next-line no-control-regex
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
      .slice(0, MAX_TEXT_LENGTH) : "";

/** A positive whole number of tokens, or undefined. */
const tokens = (value: unknown): number | undefined => {
  let n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

/** US$ per million tokens from a US$-per-token amount, or undefined for none or a negative one. */
const perMillion = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  let n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e12) / 1e6 : undefined;
};

/** A catalog property's value, which Workers AI gives as a string, as JSON or parsed. */
const parsed = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/**
 * `model` with what the model runtime's catalog says of it filling what the list left out: its
 * context window, an output cap below that window, and its price.
 */
function withRuntimeFacts(model: GatewayProviderModel): GatewayProviderModel {
  let facts = runtimeModelFacts(model.provider, model.id);
  if (!facts) return model;
  let contextWindow = model.contextWindow ?? facts.contextWindow;
  return {
    ...model,
    contextWindow,
    ...(model.outputLimit === undefined && facts.maxTokens < contextWindow &&
        model.provider !== "cloudflare" && { outputLimit: facts.maxTokens }),
    price: model.price ?? facts.price,
  };
}

/**
 * OpenRouter's list (its `/api/v1/models`): the models that call tools and answer in text, with
 * their list prices. Left out: "~" IDs, aliases that move to whichever model is newest, ":batch"
 * IDs, which answer no one waiting, and models without a usable price (its routers price as -1).
 */
export function parseOpenRouter(json: unknown): GatewayProviderModel[] {
  let models: GatewayProviderModel[] = [];
  for (let row of rows(json)) {
    let id = text(row.id);
    if (!id || id.startsWith("~") || id.endsWith(":batch")) continue;
    let supported = Array.isArray(row.supported_parameters) ? row.supported_parameters.map(String) : [];
    if (!supported.includes("tools")) continue;
    let architecture = isRecord(row.architecture) ? row.architecture : {};
    let outputs = architecture.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes("text")) continue;
    let pricing = isRecord(row.pricing) ? row.pricing : {};
    let input = perMillion(pricing.prompt);
    let output = perMillion(pricing.completion);
    if (input === undefined || output === undefined) continue;
    let contextWindow = tokens(row.context_length);
    let top = isRecord(row.top_provider) ? row.top_provider : {};
    let cap = tokens(top.max_completion_tokens);
    let inputs = architecture.input_modalities;
    let capabilities: GatewayModelCapabilities = {
      ...(Array.isArray(inputs) && { imageInput: inputs.includes("image") }),
      ...((supported.includes("reasoning") || supported.includes("reasoning_effort")) &&
          { reasoningLevels: ["low", "medium", "high"] }),
    };
    models.push({
      provider: "openrouter", id, name: text(row.name) || id,
      ...(contextWindow && { contextWindow }),
      ...(cap && contextWindow && cap < contextWindow && { outputLimit: cap }),
      ...(Object.keys(capabilities).length > 0 && { capabilities }),
      price: { input, output },
    });
  }
  return models;
}

/**
 * Anthropic's list (its `/v1/models`), page by page: the models the key can use that aren't
 * deprecated or retired. It gives no prices; its window is the input a model takes.
 */
export function parseAnthropic(pages: unknown[]): GatewayProviderModel[] {
  let models: GatewayProviderModel[] = [];
  for (let row of pages.flatMap(rows)) {
    let id = text(row.id);
    if (!id) continue;
    if (row.lifecycle !== undefined && row.lifecycle !== null && row.lifecycle !== "active") continue;
    let contextWindow = tokens(row.max_input_tokens);
    models.push({
      provider: "anthropic", id, name: text(row.display_name) || id,
      ...(contextWindow && { contextWindow }),
    });
  }
  return models;
}

const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-)/;
const OPENAI_NOT_CHAT = /(audio|realtime|tts|transcribe|image|embedding|search|instruct|moderation)/;

/**
 * OpenAI's list (its `/v1/models`): its chat models, told by their names, since the list says
 * nothing else of a model: no price, window or capability.
 */
export function parseOpenAi(json: unknown): GatewayProviderModel[] {
  return rows(json).flatMap(row => {
    let id = text(row.id);
    return id && OPENAI_CHAT.test(id) && !OPENAI_NOT_CHAT.test(id)
        ? [{ provider: "openai" as const, id, name: id }] : [];
  });
}

/**
 * The account's Workers AI catalog (`Ai#models()`): its text-generation models that call
 * functions, with their window, price and plan rate.
 */
export function parseWorkersAi(catalog: unknown): GatewayProviderModel[] {
  let models: GatewayProviderModel[] = [];
  for (let entry of Array.isArray(catalog) ? catalog.filter(isRecord) : []) {
    let id = text(entry.name);
    let task = isRecord(entry.task) ? text(entry.task.name) : "";
    if (!id || task !== "Text Generation") continue;
    let props = new Map((Array.isArray(entry.properties) ? entry.properties.filter(isRecord) : [])
        .map(prop => [String(prop.property_id), parsed(prop.value)]));
    if (String(props.get("function_calling")) !== "true") continue;
    let price: { input?: number, output?: number } = {};
    for (let item of Array.isArray(props.get("price")) ? props.get("price") as unknown[] : []) {
      if (!isRecord(item)) continue;
      let unit = String(item.unit ?? "").toLowerCase();
      let amount = Number(item.price);
      if (!Number.isFinite(amount) || amount < 0 || unit.includes("cached")) continue;
      if (unit.includes("input")) price.input = amount;
      else if (unit.includes("output")) price.output = amount;
    }
    let contextWindow = tokens(props.get("context_window"));
    models.push({
      provider: "cloudflare", id, name: id.split("/").at(-1) || id,
      ...(contextWindow && { contextWindow }),
      ...(price.input !== undefined && price.output !== undefined &&
          { price: { input: price.input, output: price.output } }),
      rateLimit: String(props.get("require_workers_paid")) === "true"
          ? WORKERS_AI_RATES.paid : WORKERS_AI_RATES.free,
    });
  }
  return models;
}

/** One GET of a provider's list through the gateway, parsed as JSON. */
async function getList(gateway: AiGatewayConfig, provider: AiModelProvider, path: string,
                       headers: Record<string, string> = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await gatewayProviderGet(
        gateway, provider, path, headers, AbortSignal.timeout(LIST_TIMEOUT_MS));
  } catch (error) {
    throw new ListFailed(`the list could not be read: ${String(error)}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ListFailed(`the list answered ${response.status}`, response.status);
  }
  return response.json();
}

/** The models `provider` lists now, unchanged by any cache; undefined for a provider with no list. */
async function readList(gateway: AiGatewayConfig, provider: AiModelProvider)
    : Promise<GatewayProviderModel[] | undefined> {
  switch (provider) {
    case "openrouter":
      // No anthropic-version header: with one, OpenRouter answers in Anthropic's shape, unpriced.
      return parseOpenRouter(await getList(gateway, provider, "openrouter/v1/models"));
    case "anthropic": {
      let pages: unknown[] = [];
      let after = "";
      for (let page = 0; page < MAX_PAGES; page++) {
        let json = await getList(gateway, provider,
            `anthropic/v1/models?limit=1000${after && `&after_id=${encodeURIComponent(after)}`}`,
            { "anthropic-version": "2023-06-01" });
        pages.push(json);
        if (!isRecord(json) || json.has_more !== true || typeof json.last_id !== "string" ||
            !json.last_id) break;
        after = json.last_id;
      }
      return parseAnthropic(pages);
    }
    case "openai":
      return parseOpenAi(await getList(gateway, provider, "openai/models"));
    case "cloudflare": {
      if (!gateway.binding) throw new ListFailed("the Workers AI catalog needs the binding");
      return parseWorkersAi(await gateway.binding.models({ per_page: 1000 } as AiModelsSearchParams));
    }
    case "aws-bedrock":
      return Object.entries(SUGGESTED_MODELS["aws-bedrock"]).map(([id, model]) =>
          ({ provider, id, name: model.name, contextWindow: model.contextWindow }));
    default:
      return undefined;
  }
}

const LABELS: Partial<Record<AiModelProvider, string>> = {
  openrouter: "OpenRouter", anthropic: "Anthropic", openai: "OpenAI", cloudflare: "Workers AI",
};

/** What a failed read of `provider`'s list comes to. */
function failed(gateway: AiGatewayConfig, provider: AiModelProvider,
                error: unknown): GatewayProviderModels {
  let label = LABELS[provider] ?? provider;
  let status = error instanceof ListFailed ? error.status : undefined;
  if (status === 401 || status === 403) {
    return {
      provider, state: "not-connected", models: [],
      note: `The AI Gateway ${gateway.gateway} holds no ${label} key, or ${label} refused it. ` +
          "Store one under the gateway's Provider Keys, with the alias default.",
    };
  }
  console.error("Couldn't read a provider's model list:", provider, String(error));
  return {
    provider, state: "unavailable", models: [],
    note: `${label}'s model list couldn't be read just now. Try again in a moment.`,
  };
}

/**
 * The models `provider` lists through `gateway` (see AdminApi.listGatewayProviderModels), each
 * filled in from the model runtime's catalog where its list says less. A read stands for ten
 * minutes; a failed one for a minute, during which a list read before keeps being served. A key the
 * provider refuses is "not-connected" at once, whatever was read before.
 */
export async function listGatewayProviderModels(gateway: AiGatewayConfig, provider: AiModelProvider,
                                                now = Date.now()): Promise<GatewayProviderModels> {
  assertGatewayProvider(provider);
  let key = `${gateway.gateway}|${provider}`;
  let hit = lists.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.listing;
  let running = reading.get(key);
  if (running) return running;
  let read = (async (): Promise<GatewayProviderModels> => {
    let listing: GatewayProviderModels;
    let ttl = LIST_TTL_MS;
    try {
      let models = await readList(gateway, provider);
      listing = models
          ? { provider, state: "ready", models: models.map(withRuntimeFacts) }
          : { provider, state: "unavailable", models: [],
              note: `${provider} has no model list to read here.` };
    } catch (error) {
      let problem = failed(gateway, provider, error);
      listing = problem.state === "unavailable" && hit?.listing.state === "ready"
          ? hit.listing : problem;
      ttl = FAILED_TTL_MS;
    } finally {
      reading.delete(key);
    }
    lists.set(key, { at: now, ttl, listing });
    return listing;
  })();
  reading.set(key, read);
  return read;
}

/**
 * `provider`'s models for a user to pick one of their own from (see
 * AuthenticatedApi.listGatewayProviderModels): only what addModel() would let them add, so only in
 * AI Gateway mode (`models` non-null), while users may add models, and under a provider that is on.
 */
export async function listGatewayProviderModelsForUser(models: GatewayModels | null,
                                                 provider: AiModelProvider)
    : Promise<GatewayProviderModels> {
  if (!models) throw new Error("This deployment does not provide models through AI Gateway.");
  models.refuseUserModel();
  if (!models.addableProviders.includes(provider)) {
    throw new Error(`Provider "${provider}" is not available on this deployment.`);
  }
  return listGatewayProviderModels(models.gateway, provider);
}
