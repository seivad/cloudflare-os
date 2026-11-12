import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { ApprovalQueue, Gatekeeper, ResourceDescription } from '@gadgets/workshop-shared/gatekeeper';
import { modelKind } from "@gadgets/workshop-shared/api";
import { getGatewayModels } from "./ai-gateway.js";
import { CatalogModel, ModelCatalog } from "./model-catalog-binding";
import MODEL_CATALOG_BINDING_TYPES from "./model-catalog-binding.txt";

/**
 * The gatekeeper behind a `modelCatalog` blueprint binding. It holds no props: the catalog is the
 * deployment's, read from the admin config at each `list()`.
 */
export class ModelCatalogGatekeeper
    extends DurableObject<Cloudflare.Env>
    implements Gatekeeper<ModelCatalog> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "http://models.local/catalog",
      title: "Model catalog",
      snippet: "The AI models this deployment's admin offers.",
      suggestedBindingName: "MODELS",
      tsType: "ModelCatalog",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return MODEL_CATALOG_BINDING_TYPES;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(_approvalQueue: RpcStub<ApprovalQueue>): Promise<ModelCatalog> {
    return new ModelCatalogImpl(this.env);
  }

  applyAction(action: number): Promise<void> {
    throw new Error("This gatekeeper implements no actions.");
  }
  rejectAction(action: number): Promise<void | {restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }
  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }

  async addObserver(_id: string, _user: Fetcher): Promise<void> {
    // The catalog is what pickers show every user, so nothing read through it identifies the
    // observer or leaks private data. No-op (never throws).
  }

  async removeObserver(_id: string): Promise<void> {
    // No observer state is tracked (see addObserver). Idempotent no-op.
  }
}

@validateRpc()
class ModelCatalogImpl extends RpcTarget implements ModelCatalog {
  constructor(private env: Cloudflare.Env) {
    super();
  }

  // The language models an admin has enabled, as pickers list them, named by CatalogModel's
  // fields alone: the rest of an AdminModel (modes, settings, limits) is the admin's.
  async list(): Promise<CatalogModel[]> {
    let models = await getGatewayModels(this.env);
    if (!models) return [];
    return models.all
        .filter(model => model.mode === "enabled" &&
            modelKind(model.provider, model.id) === "language")
        .map(({ id, name, provider, contextWindow, description }) =>
            ({ id, name, provider, contextWindow, ...(description && { description }) }));
  }
}
