import {
  AdminGatewayProvider, AdminModel, AiChatAuthorInfo, AiModelConfig, AiModelProvider,
  AutoRouterPool, GatewayModel, GatewayModelMode, HTTPS_ONLY_PROVIDERS, ModelKind, ReasoningLevel,
  SUGGESTED_MODELS, modelKind,
} from "@gadgets/workshop-shared/api";
import { readAdminConfig } from "./admin-config.js";
import type { AdminConfig } from "./storage-schema/admin-settings-storage.js";
import type { UserAiModelRecord } from "./storage-schema/user-storage.js";

// The model used for quick tasks like title generation in AI Gateway mode while the user has
// chosen none, and always on a deployment that applies Cloudflare usage limits.
//
// This 70B model is quite fast and cheap and produces pretty good titles. The cost is insignificant
// compared to the actual coding model so there's not much reason to use a smaller model.
const QUICK_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Providers AI Gateway serves: the ones gatewayNativeModel() in ai-models.ts has a route for.
 * Ollama has none, so a model added under it could never run.
 */
const GATEWAY_PROVIDERS: ReadonlySet<string> = new Set<AiModelProvider>([
  "anthropic", "openai", "google", "cloudflare", "cloudflare-auto-router", "openrouter",
  "aws-bedrock", "ai-gateway-catalog",
]);

/** The providers a model may be added under: the gateway's, less Auto Router's, which has one. */
const ADDABLE_PROVIDERS: ReadonlySet<string> =
    new Set([...GATEWAY_PROVIDERS].filter(provider => provider !== "cloudflare-auto-router"));

/** Throws unless AI Gateway serves `provider`. */
export function assertGatewayProvider(provider: string): void {
  if (!GATEWAY_PROVIDERS.has(provider)) {
    throw new Error(`Provider "${provider}" is not served through AI Gateway.`);
  }
}

/** Whether SUGGESTED_MODELS lists `modelId`, under any provider. */
export function isCatalogModel(modelId: string): boolean {
  return Object.values(SUGGESTED_MODELS).some(models => Object.hasOwn(models, modelId));
}

function tokenLimits({ contextWindow, outputLimit }
    : Pick<GatewayModel, "contextWindow" | "outputLimit">) {
  return outputLimit === undefined ? { contextWindow } : { contextWindow, outputLimit };
}

/** The config a gateway model runs with, before what its admin set for it. */
export function gatewayModelConfig(model: AdminModel): AiModelConfig {
  return {
    provider: model.provider,
    model: model.id,
    // apiToken and apiUrl are ignored when AI Gateway mode is active -- getModel()
    // reads the real values from env. We set them to empty strings here to satisfy
    // the type.
    apiToken: "",
    // An added model's limits travel in the config, which token budgeting reads ahead of the
    // catalog. A suggested model's are the catalog's own.
    ...(model.added ? tokenLimits(model) : {}),
  };
}

/**
 * The config a gateway model runs with at the reasoning level `reasoning`, or with no level set
 * when that is null, with the compaction budget `budget` when one is given, and for the Auto
 * Router model with the pool `pool` to pick from. A stored model's config (see
 * GatewayModels.runConfig) and that of a model an admin tests before adding it are both built
 * here, so that the test asks what the added model would be asked.
 */
export function gatewayRunConfig(model: AdminModel, reasoning: ReasoningLevel | null,
                                 budget?: number, pool?: AutoRouterPool): AiModelConfig {
  return {
    ...gatewayModelConfig(model),
    ...(model.behavesLike !== undefined ? { behavesLike: model.behavesLike } : {}),
    ...(model.capabilities !== undefined ? { capabilities: model.capabilities } : {}),
    ...(reasoning !== null ? { reasoning } : {}),
    ...(budget !== undefined ? { compactionInputBudget: budget } : {}),
    ...(pool !== undefined ? { autoRouterPool: pool } : {}),
  };
}

export class AiGatewayConfig {
  readonly gateway: string;
  /**
   * The gateway name for Workers-AI-binding calls (webFetch's toMarkdown): binding calls only
   * reach gateways in the Worker's own account, so this is the platform gateway whenever the
   * binding transport is active, and unset when it isn't (see {@link binding}).
   */
  readonly sameAccountGateway?: string;
  readonly accountId: string;
  readonly apiToken?: string;
  /**
   * Workers AI binding, used as the gateway transport whenever present unless
   * CF_AI_GATEWAY_USE_BINDING=false opts out: binding requests are pre-authenticated in-account,
   * so inference and cost-log reads need no API token. Binding requests only reach gateways in
   * the Worker's own account, and the Worker can't verify that itself (it can't discover its own
   * account ID), so deployments whose gateway lives in a DIFFERENT account must set the opt-out
   * and use CF_AI_GATEWAY_API_TOKEN over HTTPS. Absent in local dev unless run-dev-server is
   * started with --use-workers-ai-binding.
   *
   * Such a deployment opts out with the flag rather than by unbinding WORKERS_AI, because the
   * binding is not only the gateway transport: webFetch's document-to-Markdown conversion calls
   * `env.ai.toMarkdown()` through it (see web-fetch.ts), so unbinding would break that too.
   */
  readonly binding?: Ai;
  /** The providers CF_AI_GATEWAY_PROVIDERS lists, which an admin can add to (see GatewayModels). */
  readonly providers: Set<string>;
  /**
   * The name of the Gateway's dynamic route that answers for the routable models
   * (CF_AI_GATEWAY_ROUTE), which picks the model behind each request from the request's metadata
   * (see routedRequest in ai-models.ts). Unset on a deployment with no route.
   */
  readonly route?: string;
  /**
   * The email domains whose users are sent through {@link route}
   * (CF_AI_GATEWAY_ROUTE_DOMAINS), in lowercase. Empty sends every user.
   */
  readonly routeDomains: ReadonlySet<string>;

  constructor(env: Cloudflare.Env) {
    this.gateway = env.CF_AI_GATEWAY!;
    if (!env.CF_AI_GATEWAY_ACCOUNT_ID) {
      throw new Error("CF_AI_GATEWAY_ACCOUNT_ID is required when CF_AI_GATEWAY is set.");
    }
    this.accountId = env.CF_AI_GATEWAY_ACCOUNT_ID;
    this.apiToken = env.CF_AI_GATEWAY_API_TOKEN || undefined;
    // Normalized once, so a stray " False " opts out rather than reading as unset and silently
    // picking the other transport.
    const useBinding = env.CF_AI_GATEWAY_USE_BINDING?.trim().toLowerCase();
    this.binding = useBinding === "false"
        ? undefined
        : (env as { WORKERS_AI?: Ai }).WORKERS_AI;
    if (useBinding === "true" && !this.binding) {
      throw new Error(
          "CF_AI_GATEWAY_USE_BINDING requires the WORKERS_AI binding; without it the config " +
          "would silently fall back to the HTTPS transport.");
    }
    if (!this.apiToken && !this.binding) {
      throw new Error(
          "AI Gateway mode needs a transport: bind Workers AI (WORKERS_AI; in local dev start " +
          "with --use-workers-ai-binding) or set CF_AI_GATEWAY_API_TOKEN (a Run + Read token).");
    }
    this.sameAccountGateway = this.binding ? this.gateway : undefined;
    this.providers = new Set(
      (env.CF_AI_GATEWAY_PROVIDERS || "").split(",").map(s => s.trim()).filter(s => s !== "")
    );
    const httpsOnly = [...this.providers].filter(p => HTTPS_ONLY_PROVIDERS.has(p));
    if (httpsOnly.length > 0 && !this.apiToken) {
      const names = httpsOnly.join(", ");
      throw new Error(
          `${names} inference cannot ride the Workers AI binding transport, so enabling the ` +
          `${names} provider${httpsOnly.length > 1 ? "s" : ""} requires ` +
          "CF_AI_GATEWAY_API_TOKEN.");
    }
    // The opposite case: a catalog model is reached through the binding's run() alone (see
    // catalogRunFetch in ai-models.ts), which a token can't stand in for.
    if (this.providers.has("ai-gateway-catalog") && !this.binding) {
      throw new Error(
          "ai-gateway-catalog inference can only ride the Workers AI binding transport, so " +
          "enabling the ai-gateway-catalog provider requires the WORKERS_AI binding, with " +
          "CF_AI_GATEWAY_USE_BINDING not set to false.");
    }
    this.route = env.CF_AI_GATEWAY_ROUTE?.trim() || undefined;
    this.routeDomains = new Set((env.CF_AI_GATEWAY_ROUTE_DOMAINS || "").split(",")
        .map(s => s.trim().toLowerCase()).filter(s => s !== ""));
    // A routed request is carried as a catalog model's is, by the binding's run() (see
    // catalogRunFetch in ai-models.ts), which a token can't stand in for either.
    if (this.route && !this.binding) {
      throw new Error(
          "Requests to a dynamic route can only ride the Workers AI binding transport, as " +
          "ai-gateway-catalog inference does, so CF_AI_GATEWAY_ROUTE requires the WORKERS_AI " +
          "binding, with CF_AI_GATEWAY_USE_BINDING not set to false.");
    }
  }

  /**
   * The email domain of the user `userId` while their requests go through {@link route}: what
   * follows the "@" of the id, in lowercase. Undefined on a deployment with no route, for an id
   * that is not an email (a password account's is a bare username), and for a domain
   * {@link routeDomains} leaves out when it names any.
   */
  routedDomain(userId: string): string | undefined {
    if (this.route === undefined) return undefined;
    const at = userId.lastIndexOf("@");
    if (at <= 0 || at === userId.length - 1) return undefined;
    const domain = userId.slice(at + 1).toLowerCase();
    return this.routeDomains.size === 0 || this.routeDomains.has(domain) ? domain : undefined;
  }

  /**
   * Transport for a provider's gateway inference: the Workers AI binding when present, except for
   * the providers in {@link HTTPS_ONLY_PROVIDERS}, which ride HTTPS with the token (the
   * constructor guarantees a token whenever the environment enables one of them; one that an
   * admin enabled without a token is refused per request, in getModelViaGateway). The
   * "ai-gateway-catalog" provider has no HTTPS transport to fall back on, and is held to the
   * binding the same two ways.
   */
  bindingFor(provider: string): Ai | undefined {
    return HTTPS_ONLY_PROVIDERS.has(provider) ? undefined : this.binding;
  }

  /**
   * Get the AiModelConfig for the deployment's own quick model (used for title generation where
   * the user's choice is not).
   */
  getQuickModelConfig(): AiModelConfig | undefined {
    return {
      provider: "cloudflare",
      model: QUICK_MODEL_ID,
      apiToken: "",
    };
  }
}

/**
 * How the gateway is asked whether it holds a provider's key: a request that reads nothing of the
 * account's and sends no prompt, which the provider answers only with a key. OpenRouter's model
 * list answers without one, so its key's own endpoint is asked. Bedrock has none of these behind
 * the gateway, Google rides HTTPS only (see HTTPS_ONLY_PROVIDERS), and the gateway's own catalog
 * runs on Cloudflare's billing with no key to hold, so none of the three is checked: an admin or
 * the environment turns them on.
 */
const KEY_CHECKS: Partial<Record<AiModelProvider, { path: string; headers?: Record<string, string> }>> = {
  openai: { path: "openai/models" },
  anthropic: { path: "anthropic/v1/models?limit=1", headers: { "anthropic-version": "2023-06-01" } },
  openrouter: { path: "openrouter/v1/key" },
};

/** How long one gateway's key check stands before the next request checks again. */
const KEY_CHECK_TTL_MS = 10 * 60_000;

/**
 * How long one provider's check may take. A provider with no key can take far longer to refuse
 * (OpenAI and Anthropic took 15 seconds through the binding), and a check that times out keeps the
 * last answer.
 */
const KEY_CHECK_TIMEOUT_MS = 3_000;

/**
 * How long a caller waits for a gateway's first key check before going on with none. A provider
 * whose key the gateway holds answers well within it; the rest of the check finishes on its own
 * and the next caller has its answer.
 */
const FIRST_CHECK_WAIT_MS = 1_000;

/**
 * Each gateway's (by name) key check: the providers it answered for and when it was asked, and the
 * check in flight, if one is.
 */
const keyChecks = new Map<string, {
  at: number; keyed: ReadonlySet<string>; pending?: Promise<ReadonlySet<string>>;
}>();

/**
 * The providers `gateway` holds a working key for, as its last key check found (see
 * checkGatewayKeys): empty until one has finished in this isolate.
 */
export function gatewayKeyedProviders(gateway: AiGatewayConfig): ReadonlySet<string> {
  return keyChecks.get(gateway.gateway)?.keyed ?? new Set();
}

/**
 * The providers `gateway` holds a working key for (see KEY_CHECKS). An answer less than
 * KEY_CHECK_TTL_MS old is returned as it is; an older one is returned while a new check runs
 * behind it, so that no request waits on the gateway; and with none yet, the first check is
 * waited for FIRST_CHECK_WAIT_MS at most. A provider is keyed while its check succeeds; a 401 or
 * 403 says it has no key, and any other failure keeps what the last check found, so a passing
 * outage can't take a provider's models away mid-chat.
 */
export async function checkGatewayKeys(gateway: AiGatewayConfig,
                                       now = Date.now()): Promise<ReadonlySet<string>> {
  let entry = keyChecks.get(gateway.gateway);
  if (entry && (now - entry.at < KEY_CHECK_TTL_MS || entry.pending)) return entry.keyed;
  let last = entry?.keyed;
  let pending = askGatewayKeys(gateway, last).then(keyed => {
    keyChecks.set(gateway.gateway, { at: now, keyed });
    return keyed;
  }, () => {
    // Not expected (each provider's failure is caught), but a check that fails whole is retried.
    keyChecks.set(gateway.gateway, { at: entry?.at ?? 0, keyed: last ?? new Set() });
    return last ?? new Set<string>();
  });
  keyChecks.set(gateway.gateway, { at: entry?.at ?? 0, keyed: last ?? new Set(), pending });
  if (last) return last;
  let waited = new Promise<undefined>(resolve => AbortSignal.timeout(FIRST_CHECK_WAIT_MS)
      .addEventListener("abort", () => resolve(undefined), { once: true }));
  return (await Promise.race([pending, waited])) ?? new Set();
}

/**
 * A GET of `path` under `gateway`'s root for `provider`, over the Workers AI binding where the
 * provider rides it and otherwise over HTTPS with the gateway's token, for a read that sends no
 * prompt (a key check, a model list). The gateway's stored key for the provider applies, and the
 * request is not logged as inference.
 */
export function gatewayProviderGet(gateway: AiGatewayConfig, provider: string, path: string,
                                   headers: Record<string, string>, signal: AbortSignal)
    : Promise<Response> {
  let binding = gateway.bindingFor(provider);
  let root = binding
      ? `https://workers-binding.ai/ai-gateway/gateways/${gateway.gateway}`
      : `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.gateway}`;
  let init: RequestInit = {
    headers: {
      ...headers,
      ...(binding ? {} : { "cf-aig-authorization": `Bearer ${gateway.apiToken}` }),
      "cf-aig-collect-log": "false",
    },
    signal,
  };
  return binding
      ? (binding as unknown as { fetch: typeof fetch }).fetch(`${root}/${path}`, init)
      : fetch(`${root}/${path}`, init);
}

/** One key check of `gateway`, each provider's failure keeping what `last` found. */
async function askGatewayKeys(gateway: AiGatewayConfig,
                              last: ReadonlySet<string> | undefined): Promise<ReadonlySet<string>> {
  let results = await Promise.all(Object.entries(KEY_CHECKS).map(async ([provider, check]) => {
    try {
      let response = await gatewayProviderGet(gateway, provider, check.path, check.headers ?? {},
          AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS));
      await response.body?.cancel();
      if (response.ok) return [provider, true] as const;
      if (response.status === 401 || response.status === 403) return [provider, false] as const;
    } catch {
      // A failed or timed-out check says nothing either way.
    }
    return [provider, last?.has(provider) ?? false] as const;
  }));
  return new Set(results.filter(([, has]) => has).map(([provider]) => provider));
}

/**
 * Parse AI Gateway configuration from environment variables. Returns null if AI Gateway
 * mode is not enabled (i.e. CF_AI_GATEWAY is not set).
 */
export function getAiGatewayConfig(env: Cloudflare.Env): AiGatewayConfig | null {
  if (!env.CF_AI_GATEWAY) return null;
  return new AiGatewayConfig(env);
}

/**
 * How AI Gateway names each provider Auto Router routes to: in its `cf-aig-allowed-providers`
 * header, and as the prefix of the provider's models in `cf-aig-allowed-models` (Workers AI
 * models keep their own `@cf/` names there). Google is absent because the router's pool holds no
 * Google models, and Ollama because the gateway serves none.
 */
export const AUTO_ROUTER_PROVIDER_NAMES:
    Partial<Record<AiModelProvider, { header: string; prefix: string }>> = {
  anthropic: { header: "anthropic", prefix: "anthropic/" },
  openai: { header: "openai", prefix: "openai/" },
  cloudflare: { header: "workers-ai", prefix: "@cf/" },
};

/** The provider of ours that a gateway model name in an Auto Router allow-list belongs to. */
export function allowedModelProvider(name: string): AiModelProvider | undefined {
  for (let [provider, names] of Object.entries(AUTO_ROUTER_PROVIDER_NAMES)) {
    if (name.startsWith(names.prefix)) return provider as AiModelProvider;
  }
  return undefined;
}

/**
 * The models a deployment provides through AI Gateway (`gateway`), each in the mode its admin
 * gave it (see GatewayModelMode): the suggested models of every provider the deployment enables
 * (`providers`), each provider's followed by the models the admin added under it, in the order
 * the admin gave the providers and their models (AdminConfig.providerOrder and modelOrder).
 * Listing and resolving a gateway model both go through here, so neither can happen without the
 * admin's modes, settings and order; and where a model is picked by default, it is the first.
 */
export class GatewayModels {
  /**
   * The providers the deployment enables: the environment's, which are a floor, the ones the
   * gateway holds a working key for (see checkGatewayKeys), and the ones its admin added that the
   * gateway serves.
   */
  readonly providers: ReadonlySet<string>;
  /** The providers the gateway holds a working key for, as its last key check found. */
  readonly #keyed: ReadonlySet<string>;
  /** Every model, in any mode, in listing order. */
  readonly all: readonly AdminModel[];
  /** The providers a model may be added under: the ones the gateway both enables and serves. */
  readonly addableProviders: AiModelProvider[] = [];
  /**
   * Whether users may add models of their own, which run through the gateway like these. When
   * false, these are the only models a user can list or run.
   */
  readonly userModels: boolean;
  readonly #byId = new Map<string, AdminModel>();
  /** The stored added models, including the ones this table leaves out. */
  readonly #added: readonly GatewayModel[];
  /** The reasoning level of a model whose settings give none. */
  readonly #defaultReasoning: ReasoningLevel | null;
  /** Every provider, enabled or not, in listing order. */
  readonly #providerOrder: AiModelProvider[];

  constructor(readonly gateway: AiGatewayConfig,
              config: Pick<AdminConfig, "modelModes" | "addedProviders" | "providerOrder" |
                  "addedModels" | "modelOrder" | "userModelsEnabled" | "modelSettings" |
                  "defaultReasoning">,
              keyed: ReadonlySet<string> = gatewayKeyedProviders(gateway)) {
    this.#keyed = keyed;
    this.providers = new Set([
      ...gateway.providers,
      ...keyed,
      ...config.addedProviders.filter(provider => GATEWAY_PROVIDERS.has(provider)),
    ]);
    this.#added = config.addedModels;
    this.userModels = config.userModelsEnabled;
    this.#defaultReasoning = config.defaultReasoning;
    this.#providerOrder = [...new Set([
      ...config.providerOrder, ...Object.keys(SUGGESTED_MODELS) as AiModelProvider[],
    ])];
    let add = (model: GatewayModel, defaultMode: GatewayModelMode, added: boolean) => {
      if (this.#byId.has(model.id)) return;
      // Object.hasOwn, so that an ID like "constructor" does not find an inherited mode.
      let mode = Object.hasOwn(config.modelModes, model.id)
          ? config.modelModes[model.id] : defaultMode;
      let settings = Object.hasOwn(config.modelSettings, model.id)
          ? config.modelSettings[model.id] : undefined;
      this.#byId.set(
          model.id, { ...model, mode, defaultMode, added, ...(settings && { settings }) });
    };
    // With no provider Auto Router routes to on, its model would fail every request, so it is
    // not offered.
    let routable = [...this.providers]
        .some(provider => AUTO_ROUTER_PROVIDER_NAMES[provider as AiModelProvider] !== undefined);
    for (let provider of this.#providerOrder) {
      if (!this.providers.has(provider)) continue;
      if (provider === "cloudflare-auto-router" && !routable) continue;
      for (let [id, model] of Object.entries(SUGGESTED_MODELS[provider])) {
        add({ provider, id, name: model.name,
              ...(model.description && { description: model.description }), ...tokenLimits(model) },
            model.hidden ? "hidden" : "enabled", false);
      }
      if (!ADDABLE_PROVIDERS.has(provider)) continue;
      this.addableProviders.push(provider);
      for (let model of config.addedModels) {
        // A gateway model is looked up by ID alone, so the catalog wins an ID it lists under any
        // provider, whether or not the gateway enables that one.
        if (model.provider === provider && !isCatalogModel(model.id)) add(model, "enabled", true);
      }
    }
    // The models a provider's order lists come first, in its order. The sort is stable, so the
    // rest keep their places after them.
    let rank = (model: AdminModel) => {
      let listed = config.modelOrder[model.provider] ?? [];
      let at = listed.indexOf(model.id);
      return at === -1 ? listed.length : at;
    };
    let providerRank = (model: AdminModel) => this.#providerOrder.indexOf(model.provider);
    this.all = [...this.#byId.values()]
        .toSorted((a, b) => providerRank(a) - providerRank(b) || rank(a) - rank(b));
  }

  /** Every provider the gateway serves, enabled or not, in listing order. */
  get providerSettings(): AdminGatewayProvider[] {
    return this.#providerOrder.filter(provider => GATEWAY_PROVIDERS.has(provider))
        .map(provider => ({
          provider,
          ...(this.providers.has(provider) && {
            enabledBy: this.gateway.providers.has(provider) ? "environment"
                : this.#keyed.has(provider) ? "gateway" : "admin",
          }),
          // What getModelViaGateway refuses a request for. Only an admin can enable a provider
          // in that state: the environment enabling one keeps `gateway` from being built.
          needsApiToken: !this.gateway.bindingFor(provider) && !this.gateway.apiToken,
        }));
  }

  /** Whether the gateway's key check, rather than the environment or an admin, keeps `provider` on. */
  keyedByGateway(provider: string): boolean {
    return this.#keyed.has(provider) && !this.gateway.providers.has(provider);
  }

  /** The gateway model with this ID, in any mode: even a disabled model's ID stays reserved. */
  get(id: string): AdminModel | undefined {
    return this.#byId.get(id);
  }

  /**
   * The models of one kind offered in pickers, i.e. the enabled ones, as AiChatAuthorInfo
   * entries.
   */
  list(kind: ModelKind): AiChatAuthorInfo[] {
    return this.all.filter(model =>
            model.mode === "enabled" && modelKind(model.provider, model.id) === kind)
        .map(({ id, name, description }) =>
            ({ type: "agent", id, name, ...(description && { description }) }));
  }

  /**
   * Look up a gateway model by ID in order to run it. Hidden models resolve, so stored references
   * to them keep working. Returns undefined for a disabled model and for an ID that names no
   * gateway model.
   */
  resolve(id: string): UserAiModelRecord | undefined {
    let model = this.#byId.get(id);
    let config = this.runConfig(id);
    if (!model || !config || model.mode === "disabled") return undefined;
    return { profile: { type: "agent", id, name: model.name }, config };
  }

  /**
   * The config a gateway model runs with, whatever its mode: a disabled model has one too, for
   * an admin to test it with, and whether a model may run is for resolve() and refuseDisabled()
   * to say. Returns undefined for an ID that names no gateway model. The config carries what the
   * admin set and nothing for what is unset, so that an untouched model runs exactly as it does
   * with no admin settings at all.
   */
  runConfig(id: string): AiModelConfig | undefined {
    let model = this.#byId.get(id);
    if (!model) return undefined;
    return gatewayRunConfig(model, model.settings?.reasoning ?? this.#defaultReasoning,
        model.settings?.compactionInputBudget,
        model.provider === "cloudflare-auto-router"
            ? this.autoRouterPool(model.settings?.allowedModels) : undefined);
  }

  /**
   * The pool an Auto Router model whose admin listed `listed` picks from, or that one with no
   * list picks from when it is undefined: the listed models of enabled providers, or else those
   * providers whole. It never exceeds the enabled providers, so a listed model drops out once its
   * provider is turned off.
   */
  autoRouterPool(listed: string[] | undefined): AutoRouterPool {
    if (listed === undefined) return { providers: this.addableProviders };
    return { models: listed.filter(name => this.enablesProviderOf(name)) };
  }

  /** Whether a gateway model name belongs to a provider the deployment enables. */
  enablesProviderOf(name: string): boolean {
    let provider = allowedModelProvider(name);
    return provider !== undefined && this.addableProviders.includes(provider);
  }

  /** Throws if `id` names a gateway model that an admin disabled. */
  refuseDisabled(id: string): void {
    let model = this.#byId.get(id);
    if (model?.mode === "disabled") {
      throw new Error(
          `The "${model.name}" model is disabled on this deployment by an administrator.`);
    }
  }

  /**
   * Throws unless users may add models of their own. `name` is that of the model being run, when
   * the refusal is of one a user added rather than of adding one.
   */
  refuseUserModel(name?: string): void {
    if (this.userModels) return;
    throw new Error(name === undefined
        ? "Adding your own models is disabled on this deployment by an administrator."
        : `The "${name}" model can't be used: adding your own models is disabled on this ` +
          "deployment by an administrator.");
  }

  /**
   * Throws unless `model`, already well-formed (see sanitizeAddedModel), may join the added
   * models: the gateway serves and enables its provider, and its ID is free. An ID the catalog
   * lists under any provider is taken, as is that of a stored added model this table leaves out.
   */
  assertAddable(model: GatewayModel): void {
    assertGatewayProvider(model.provider);
    if (!ADDABLE_PROVIDERS.has(model.provider)) {
      throw new Error(`Models can't be added under provider "${model.provider}".`);
    }
    if (!this.providers.has(model.provider)) {
      throw new Error(`Provider "${model.provider}" is not enabled on this deployment.`);
    }
    if (isCatalogModel(model.id)) throw new Error(`"${model.id}" is already a suggested model.`);
    if (this.#added.some(added => added.id === model.id)) {
      throw new Error(`"${model.id}" is already an added model.`);
    }
  }
}

/**
 * The deployment's AI Gateway models, or null if AI Gateway mode is not enabled. Only a gateway
 * deployment reads the admin config for them.
 */
export async function getGatewayModels(env: Cloudflare.Env): Promise<GatewayModels | null> {
  let gateway = getAiGatewayConfig(env);
  if (!gateway) return null;
  let [config, keyed] = await Promise.all([readAdminConfig(env), checkGatewayKeys(gateway)]);
  return new GatewayModels(gateway, config, keyed);
}

/** Identifies the Gateway and credentials needed to retrieve an inference log. */
export type AiGatewayLogRoute =
  | { gateway: string }
  | { gateway: string; accountId: string; apiToken: string };

/** Indicates a transient AI Gateway log lookup failure that should be retried. */
export class AiGatewayLogRetryableError extends Error {}

function validateLogCost(cost: unknown): number {
  if (cost === undefined || cost === null) {
    throw new AiGatewayLogRetryableError("AI Gateway log cost is not available yet.");
  }
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new Error("AI Gateway log response contained an invalid cost.");
  }
  return cost;
}

/**
 * What an AI Gateway log says about one inference: its cost, plus the model that ran, the request
 * metadata the gateway recorded, and token counts. Only the cost is always present.
 */
export type AiGatewayLogRecord = {
  cost: number;
  model?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  tokensIn?: number;
  tokensOut?: number;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalMetadata(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
}

function optionalDate(value: unknown): Date | undefined {
  if (typeof value !== "string" && !(value instanceof Date)) return undefined;
  let date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Reads a log's fields from either transport's shape (both name them in snake_case). */
function toLogRecord(log: Record<string, unknown> | AiGatewayLog): AiGatewayLogRecord {
  return {
    cost: validateLogCost(log.cost),
    model: optionalString(log.model),
    metadata: optionalMetadata(log.metadata),
    createdAt: optionalDate(log.created_at),
    tokensIn: optionalCount(log.tokens_in),
    tokensOut: optionalCount(log.tokens_out),
  };
}

/** Retrieve the cost recorded for an AI Gateway log. */
export async function getAiGatewayLogCost(
    env: Cloudflare.Env, route: AiGatewayLogRoute, logId: string): Promise<number> {
  return (await getAiGatewayLog(env, route, logId)).cost;
}

/** Retrieve an AI Gateway log: its cost, model, metadata, token counts and creation time. */
export async function getAiGatewayLog(
    env: Cloudflare.Env, route: AiGatewayLogRoute, logId: string): Promise<AiGatewayLogRecord> {
  if (!("accountId" in route)) {
    let log: AiGatewayLog;
    try {
      log = await env.WORKERS_AI.gateway(route.gateway).getLog(logId);
    } catch (error) {
      throw new AiGatewayLogRetryableError("AI Gateway binding log request failed.", {
        cause: error,
      });
    }
    return toLogRecord(log);
  }

  let url = "https://api.cloudflare.com/client/v4/accounts/" +
      `${encodeURIComponent(route.accountId)}/ai-gateway/gateways/` +
      `${encodeURIComponent(route.gateway)}/logs/${encodeURIComponent(logId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${route.apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log request failed.", { cause: error });
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 408 || response.status === 429 ||
        response.status >= 500) {
      throw new AiGatewayLogRetryableError(
          `AI Gateway log request failed with status ${response.status}.`);
    }
    throw new Error(`AI Gateway log request failed with status ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log response could not be read.", {
      cause: error,
    });
  }
  if (typeof body !== "object" || body === null || !("success" in body) ||
      body.success !== true || !("result" in body) ||
      typeof body.result !== "object" || body.result === null) {
    throw new Error("AI Gateway log response was malformed.");
  }

  return toLogRecord(body.result as Record<string, unknown>);
}

/**
 * The log route of a gateway configuration. Cost-log reads are same-account, so the binding arm
 * applies whenever the binding transport is active (config.binding is unset when
 * CF_AI_GATEWAY_USE_BINDING=false opts out) -- even for Google inference, which itself rides
 * HTTPS (see AiGatewayConfig.bindingFor).
 */
export function gatewayLogRoute(config: AiGatewayConfig, gateway: string = config.gateway):
    AiGatewayLogRoute {
  return config.binding
      ? { gateway }
      : { gateway, accountId: config.accountId, apiToken: config.apiToken! };
}

/** The deployment gateway's log route, or undefined when AI Gateway mode is not enabled. */
export function deploymentLogRoute(env: Cloudflare.Env): AiGatewayLogRoute | undefined {
  let config = getAiGatewayConfig(env);
  return config ? gatewayLogRoute(config) : undefined;
}
