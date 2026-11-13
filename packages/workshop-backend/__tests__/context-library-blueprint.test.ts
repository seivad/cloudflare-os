// A gadget that holds the Skills library (a `contextLibrary` gatekeeper) exports it as a blueprint
// binding that names no resource, and an ambient capsule of the same library stays out of the
// blueprint. Runs against a real OverseerDurableObject.

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

const GADGET = 100, LIBRARY = 1, AMBIENT = 2;

describe("collectBindingMetadata with the Skills library", () => {
  it("exports the bound library as a bare contextLibrary binding and drops the ambient capsule",
      async () => {
    let stub = env.TEST_OVERSEER.getByName("context-library-blueprint");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.storage.gadgets.put(
          { type: "gadget", id: GADGET, title: "G", created: new Date(0), bindingName: "G",
            bindings: {} });
      impl.storage.gatekeepers.put({
        id: LIBRARY, resourceTitle: "Skills", class: {} as any,
        creationSpec: { type: "contextLibrary", vendorId: "context", accountId: 7 },
      });
      impl.storage.gatekeepers.put({
        id: AMBIENT, resourceTitle: "Skills", class: {} as any,
        creationSpec: { type: "ambient", vendorId: "context", accountId: 7 },
      });
      impl.bindWorkpiece(GADGET, "CONTEXT", LIBRARY);
      impl.bindWorkpiece(GADGET, "AMBIENT", AMBIENT);

      let bindings: Record<string, BlueprintBinding> =
          JSON.parse(JSON.stringify(impl.collectBindingMetadata(GADGET)));

      expect(Object.keys(bindings)).toEqual(["CONTEXT"]);
      expect(bindings.CONTEXT).toMatchObject({ type: "contextLibrary" });
      expect(bindings.CONTEXT).not.toHaveProperty("accountId");
    });
  });
});
