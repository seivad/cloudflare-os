// The Skills library binding: whose account it takes, what it does with none, and that an admin
// turning Skills off stops a bound gadget reading it. The client side runs against the forged
// overseer of fixtures.ts; the session check against a real OverseerDurableObject.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import { NO_SKILLS_ACCOUNT, SKILLS_TURNED_OFF, skillsBindingsLeftOut } from "../src/skills-binding.js";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const SKILLS = {
  accountId: 7, vendorId: "context",
  description: { displayName: "Skills", singleton: { tsType: "ContextLibrary" } },
};
const OTHER_SINGLETON = {
  accountId: 8, vendorId: "other", description: { displayName: "Other", singleton: { tsType: "Other" } },
};

function fakeClient(accounts: unknown[]) {
  let added: { spec: unknown; actor: string }[] = [];
  let classes: number[] = [];
  // Every collection open() lists is empty.
  let storage = new Proxy({}, { get: () => ({ list: () => [], get: () => undefined }) });
  let opened = openFakeOverseer(storage, {
    userId: "caller-id",
    ownerId: "owner-id",
    impl: {
      users: {
        idFromString: (id: string) => id,
        get: (id: string) => ({
          whoami: async () => ({ id: "profile-id", name: "Test User" }),
          recordSharedWorkspaceOpen: async () => {},
          listProvidedAccounts: async () => id === "caller-id" ? accounts : [],
          getSingletonGatekeeperClass: async (accountId: number) => { classes.push(accountId); return {}; },
        }),
      },
      addGatekeeper: async (_cls: unknown, spec: unknown, actor: string) => {
        added.push({ spec, actor });
        return {};
      },
    },
  });
  return { opened, added, classes };
}

describe("newContextLibraryGatekeeper", () => {
  it("binds the calling user's Skills account, not the workspace owner's", async () => {
    let { opened, added, classes } = fakeClient([OTHER_SINGLETON, SKILLS]);

    await (await opened).newContextLibraryGatekeeper();

    expect(classes).toEqual([7]);
    expect(added).toEqual([{
      spec: { type: "contextLibrary", vendorId: "context", userId: "caller-id", accountId: 7 },
      actor: "caller-id",
    }]);
  });

  it("refuses with one sentence when the caller has no Skills account", async () => {
    let { opened, added } = fakeClient([OTHER_SINGLETON]);

    await expect((await opened).newContextLibraryGatekeeper()).rejects.toThrow(NO_SKILLS_ACCOUNT);
    expect(added).toEqual([]);
    expect(NO_SKILLS_ACCOUNT).toMatch(/Connectors page.*admin/);
  });
});

let doCounter = 0;

async function withImpl(accounts: unknown[], fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`context-library-binding-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.storage.gatekeepers.put({
      id: 1, resourceTitle: "Skills", class: {} as any,
      creationSpec: { type: "contextLibrary", vendorId: "context", userId: "u1", accountId: 7 },
    });
    impl.users = {
      idFromString: (id: string) => id,
      get: (id: string) => ({ listProvidedAccounts: async () => id === "u1" ? accounts : [] }),
    };
    await fn(impl);
  });
}

describe("a bound Skills library session", () => {
  let facet = { startSession: (queue: unknown) => ({ session: queue }) };

  it("opens while the account is still provided", () => withImpl([SKILLS], async impl => {
    await expect(impl.openGatekeeperSession(1, facet, { from: "gadget", gadgetId: 100 }))
        .resolves.toMatchObject({ session: expect.anything() });
  }));

  it("refuses every call once Skills is turned off or the account was replaced",
      async () => {
    for (let accounts of [[], [{ ...SKILLS, accountId: 9 }]]) {
      await withImpl(accounts, async impl => {
        await expect(impl.openGatekeeperSession(1, facet, { from: "gadget", gadgetId: 100 }))
            .rejects.toThrow(SKILLS_TURNED_OFF);
      });
    }
    expect(SKILLS_TURNED_OFF).toBe("Skills is turned off for this account.");
  });
});

describe("skillsBindingsLeftOut", () => {
  let base = { title: "Skills", description: "" };
  let blueprint = (optional: boolean) => ({
    CONTEXT: { ...base, type: "contextLibrary" as const, ...(optional ? { optional: true as const } : {}) },
  });
  let assigned = { CONTEXT: { type: "contextLibrary" as const } };

  it("leaves an optional binding out for a user with no Skills account", () => {
    expect([...skillsBindingsLeftOut(assigned, blueprint(true), false)]).toEqual(["CONTEXT"]);
  });

  it("refuses a required binding for a user with no Skills account, before anything is made", () => {
    expect(() => skillsBindingsLeftOut(assigned, blueprint(false), false)).toThrow(NO_SKILLS_ACCOUNT);
  });

  it("leaves nothing out for a user who has the account", () => {
    expect(skillsBindingsLeftOut(assigned, blueprint(false), true).size).toBe(0);
    expect(skillsBindingsLeftOut(assigned, blueprint(true), true).size).toBe(0);
  });

  it("refuses an assignment the blueprint does not declare as a Skills binding", () => {
    expect(() => skillsBindingsLeftOut(assigned, { CONTEXT: { ...base, type: "modelCatalog" } }, true))
        .toThrow("type mismatch");
  });
});
