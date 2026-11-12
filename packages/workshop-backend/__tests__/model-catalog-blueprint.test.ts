// A model catalog binding is stateless, so a spawner whose env names one exports as a blueprint:
// the binding is synthesized for the spawner like an external resource's or a model's, and a
// binding the gadget holds itself is shared. Runs against a real OverseerDurableObject.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { BlueprintBinding } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const GADGET = 100, CATALOG = 1, SPAWNER = 2;
let doCounter = 0;

async function withImpl(heldByGadget: boolean, fn: (impl: any) => void): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`model-catalog-blueprint-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.storage.gadgets.put(
        { type: "gadget", id: GADGET, title: "G", created: new Date(0), bindingName: "G",
          bindings: {} });
    impl.storage.gatekeepers.put({
      id: CATALOG, resourceTitle: "Model catalog", class: {} as any,
      creationSpec: { type: "modelCatalog" },
    });
    impl.storage.gatekeepers.put({
      id: SPAWNER, resourceTitle: "Spawner", class: {} as any,
      creationSpec: { type: "agentSpawner", config: { displayName: "S", modelId: null } },
      bindings: { MODELS: { target: CATALOG } },
    });
    if (heldByGadget) impl.bindWorkpiece(GADGET, "CATALOG", CATALOG);
    impl.bindWorkpiece(GADGET, "SPAWN", SPAWNER);
    fn(impl);
  });
}

describe("collectBindingMetadata with a model catalog", () => {
  it("exports a spawner's catalog binding as a spawner-only one that survives JSON",
      () => withImpl(false, impl => {
    let bindings: Record<string, BlueprintBinding> =
        JSON.parse(JSON.stringify(impl.collectBindingMetadata(GADGET)));
    expect(bindings.MODELS).toMatchObject({ type: "modelCatalog", spawnerOnly: true });
    expect(bindings.SPAWN).toMatchObject(
        { type: "agentSpawner", env: { MODELS: { type: "binding", name: "MODELS" } } });
  }));

  it("shares the gadget's own catalog binding with the spawner",
      () => withImpl(true, impl => {
    let bindings = impl.collectBindingMetadata(GADGET);
    expect(bindings.CATALOG).toMatchObject({ type: "modelCatalog" });
    expect(bindings.CATALOG.spawnerOnly).toBeUndefined();
    expect(bindings.SPAWN.env).toEqual({ MODELS: { type: "binding", name: "CATALOG" } });
    expect(Object.keys(bindings).toSorted()).toEqual(["CATALOG", "SPAWN"]);
  }));
});
