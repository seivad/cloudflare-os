/** One model of the deployment's catalog. */
export interface CatalogModel {
  /** The ID the model is referred to by. */
  id: string;
  /** Display name. */
  name: string;
  /** Which AI provider hosts the model. */
  provider: string;
  /** The maximum tokens one request may total. */
  contextWindow: number;
  /** A line describing the model, when it has one. */
  description?: string;
}

/** Binding to the deployment's model catalog: the models its admin offers for use. */
export interface ModelCatalog {
  /**
   * The models the admin offers, in the admin's order. Read at each call, so it follows the
   * admin's changes. Empty on a deployment with no AI Gateway.
   */
  list(): Promise<CatalogModel[]>;
}
