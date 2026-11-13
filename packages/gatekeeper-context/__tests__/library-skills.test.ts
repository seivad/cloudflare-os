import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ObservationGate, type ObserverKv } from "@gadgets/gatekeeper-kit/observers";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { contextObserverStrategy } from "../src/context-observers.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import { LibraryReadSession } from "../src/library-read.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import { domainName } from "../src/domain.js";
import { manifest } from "./skill-directory-fixtures.js";

type TestEnv = { COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject> };
const testEnv = env as unknown as TestEnv & Cloudflare.Env;

let domain = "";
let domains = 0;
let nextId = 0;
beforeEach(() => {
  domain = `skills-${domains++}.example`;
});

const collection = (id: string) =>
  testEnv.COLLECTIONS.get(testEnv.COLLECTIONS.idFromName(domainName(domain, id)));

async function createCollection(title: string, visibility: "private" | "public" = "private"): Promise<string> {
  let id = `collection-${nextId++}`;
  let now = new Date();
  await collection(id).initialize({
    id, title, description: "", visibility,
    created: now, lastUpdated: now, documentCount: 0, content: { source: "web" },
  }, domain, visibility === "private" ? "owner" : "");
  return id;
}

const bytesBase64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

async function addSkill(collectionId: string, directory: string, name: string,
    extra: { path: string; body: string; contentType?: string }[] = []): Promise<void> {
  let stub = collection(collectionId);
  await stub.createContextSkill(`${directory}/SKILL.md`, {
    description: `Use ${name}.`, body: manifest(name),
  });
  for (let file of extra) {
    await stub.putContextDocument(`${directory}/${file.path}`, {
      description: "", body: file.body, contentType: file.contentType,
    });
  }
}

function makeKv(): ObserverKv {
  let map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, value),
    delete: (key: string) => void map.delete(key),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][],
  };
}

/** A session over real collections; `library` is the owner's private library, and no collection is public. */
function makeSession(library: string[], options: { refusal?: Error } = {}) {
  let authorized: ObservationDescription[] = [];
  let authorizer = {
    async authorizeObservation(description: ObservationDescription) {
      if (options.refusal) throw options.refusal;
      authorized.push(description);
    },
    [Symbol.dispose]() {},
  };
  let userLibraries = {
    idFromName: (name: string) => name,
    get: () => ({
      async listPrivateLibrary() { return library.map(id => ({ id })); },
      async hasPrivateLibraryCollection(_domain: string, _account: string, id: string) {
        return library.includes(id);
      },
    }),
  } as unknown as DurableObjectNamespace<UserLibraryDurableObject>;
  let kvEnv = {
    CONTEXT_COLLECTIONS: { async get() { return "[]"; } },
  } as unknown as Pick<Cloudflare.Env, "CONTEXT_COLLECTIONS">;
  let strategy = contextObserverStrategy(makeKv(), domain);
  let session = new LibraryReadSession(
    kvEnv, testEnv.COLLECTIONS, userLibraries, domain, "owner",
    new ObservationGate(
      authorizer as unknown as ConstructorParameters<typeof ObservationGate>[0], strategy));
  return { session, authorized };
}

describe("LibraryReadSession.listSkillCollections", () => {
  it("lists the collections that hold skills, not those that do not or cannot be read", async () => {
    let withSkills = await createCollection("Skills");
    let docsOnly = await createCollection("Docs");
    let unreadable = await createCollection("Theirs");
    await addSkill(withSkills, "triage", "triage");
    await collection(docsOnly).putContextDocument("plan.md", { description: "", body: "Plan.\n" });
    await addSkill(unreadable, "secret", "secret");
    let { session, authorized } = makeSession([withSkills, docsOnly]);

    let collections = await session.listSkillCollections();

    expect(collections).toEqual([{
      collectionId: withSkills, name: "Skills", audience: "private",
    }]);
    // Discovery metadata, as list() with no collection: nothing is observed.
    expect(authorized).toEqual([]);
  });

  it("says who else can read each collection", async () => {
    let alone = await createCollection("Alone");
    let shared = await createCollection("Shared");
    let everyone = await createCollection("Everyone");
    for (let id of [alone, shared, everyone]) await addSkill(id, "triage", "triage");
    await collection(shared).share("owner", [{ accountId: "bob", displayName: "Bob" }], "viewer");
    await collection(everyone).setEveryoneCanView("owner", true);
    let { session } = makeSession([alone, shared, everyone]);

    let audiences = Object.fromEntries(
      (await session.listSkillCollections()).map(entry => [entry.name, entry.audience]));

    expect(audiences).toEqual({ Alone: "private", Shared: "shared", Everyone: "public" });
  });

  it("lists a public collection as public", async () => {
    let id = await createCollection("Everyone's", "public");
    await addSkill(id, "triage", "triage");
    let kvEnv = { CONTEXT_COLLECTIONS: { async get() { return JSON.stringify([{ id, lastUpdated: new Date() }]); } } };
    let strategy = contextObserverStrategy(makeKv(), domain);
    let userLibraries = {
      idFromName: (name: string) => name,
      get: () => ({ async listPrivateLibrary() { return []; } }),
    } as unknown as DurableObjectNamespace<UserLibraryDurableObject>;
    let session = new LibraryReadSession(
      kvEnv as unknown as Pick<Cloudflare.Env, "CONTEXT_COLLECTIONS">, testEnv.COLLECTIONS, userLibraries,
      domain, "owner",
      new ObservationGate({ async authorizeObservation() {}, [Symbol.dispose]() {} } as never, strategy));

    expect(await session.listSkillCollections()).toEqual([
      { collectionId: id, name: "Everyone's", audience: "public" }]);
  });
});

describe("LibraryReadSession.listSkills", () => {
  it("lists a skill from a readable collection and none from an unreadable one", async () => {
    let readable = await createCollection("Mine");
    let unreadable = await createCollection("Theirs");
    await addSkill(readable, "triage", "triage", [{ path: "notes.md", body: "Notes.\n" }]);
    await addSkill(unreadable, "secret", "secret");
    let { session, authorized } = makeSession([readable]);

    let skills = await session.listSkills(readable);

    expect(await session.listSkills(unreadable)).toEqual([]);
    expect(skills).toEqual([{
      collectionId: readable,
      collectionName: "Mine",
      manifestPath: "triage/SKILL.md",
      name: "triage",
      description: "Use triage.",
      fileCount: 2,
      totalBytes: new TextEncoder().encode(manifest("triage")).byteLength + 7,
      revision: expect.stringMatching(/^[0-9a-f]{64}$/),
    }]);
    // Reading the index reveals this collection's contents, so the Workshop checks it for each
    // viewer, and only this collection: the unreadable one is not even asked about.
    expect(authorized).toEqual([expect.objectContaining({ subresources: [readable] })]);
  });

  it("changes a skill's revision when a file of it changes, and only then", async () => {
    let id = await createCollection("Mine");
    await addSkill(id, "triage", "triage");
    await addSkill(id, "other", "other");
    let { session } = makeSession([id]);
    let before = new Map((await session.listSkills(id)).map(skill => [skill.name, skill.revision]));

    await collection(id).putContextDocument("triage/notes.md", { description: "", body: "More.\n" });
    let after = new Map((await session.listSkills(id)).map(skill => [skill.name, skill.revision]));

    expect(after.get("triage")).not.toBe(before.get("triage"));
    expect(after.get("other")).toBe(before.get("other"));
  });

  it("observes nothing when the library holds no skill", async () => {
    let id = await createCollection("Docs");
    await collection(id).putContextDocument("plan.md", { description: "", body: "Plan.\n" });
    let { session, authorized } = makeSession([id]);

    expect(await session.listSkills(id)).toEqual([]);
    expect(authorized).toEqual([]);
  });

  it("returns no data when the Workshop refuses the observation", async () => {
    let id = await createCollection("Mine");
    await addSkill(id, "triage", "triage");
    let { session } = makeSession([id], { refusal: new Error("A collaborator cannot read this.") });

    await expect(session.listSkills(id)).rejects.toThrow("A collaborator cannot read this.");
    await expect(session.readSkill(id, "triage/SKILL.md")).rejects.toThrow("A collaborator cannot read this.");
  });
});

describe("LibraryReadSession.readSkill", () => {
  it("returns SKILL.md first, then the supporting files", async () => {
    let id = await createCollection("Mine");
    await addSkill(id, "triage", "triage", [
      { path: "a/zeta.md", body: "Zeta.\n" },
      { path: "alpha.md", body: "Alpha.\n" },
    ]);
    await addSkill(id, "triage-two", "triage-two");
    let { session, authorized } = makeSession([id]);

    let skill = await session.readSkill(id, "triage/SKILL.md");

    expect(skill.name).toBe("triage");
    expect(skill.description).toBe("Use triage.");
    expect(skill.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(skill.files.map(file => file.path)).toEqual(["SKILL.md", "a/zeta.md", "alpha.md"]);
    expect(skill.files[0].text).toBe(manifest("triage"));
    expect(skill.leftOut).toEqual([]);
    expect(authorized).toEqual([expect.objectContaining({ subresources: [id] })]);
  });

  it("leaves out a binary file and a file over 256 KB, and says why", async () => {
    let id = await createCollection("Mine");
    await addSkill(id, "triage", "triage", [
      { path: "logo.png", body: bytesBase64([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), contentType: "image/png" },
      { path: "big.txt", body: "x".repeat(256 * 1024 + 1), contentType: "text/plain" },
      { path: "ok.txt", body: "fine", contentType: "text/plain" },
    ]);
    let { session } = makeSession([id]);

    let skill = await session.readSkill(id, "triage/SKILL.md");

    expect(skill.files.map(file => file.path)).toEqual(["SKILL.md", "ok.txt"]);
    expect(skill.leftOut).toEqual([
      { path: "big.txt", reason: "Over 256 KB." },
      { path: "logo.png", reason: "Not UTF-8 text." },
    ]);
  });

  it("refuses a skill of more than 100 files with a sentence that gives no count", async () => {
    let id = await createCollection("Mine");
    await addSkill(id, "triage", "triage", Array.from({ length: 100 }, (_, index) =>
      ({ path: `f${index}.md`, body: "x" })));
    let { session } = makeSession([id]);

    await expect(session.readSkill(id, "triage/SKILL.md"))
      .rejects.toThrow("This skill has too many files to add.");
  });

  it("refuses a skill whose text totals more than 1 MB, authorizing nothing", async () => {
    let id = await createCollection("Mine");
    await addSkill(id, "triage", "triage", Array.from({ length: 5 }, (_, index) =>
      ({ path: `f${index}.txt`, body: "x".repeat(250 * 1024), contentType: "text/plain" })));
    let { session, authorized } = makeSession([id]);

    await expect(session.readSkill(id, "triage/SKILL.md"))
      .rejects.toThrow("This skill has too much text to add.");
    expect(authorized).toEqual([]);
  });

  it("refuses a collection the session cannot read, and a path that is not a skill", async () => {
    let readable = await createCollection("Mine");
    let unreadable = await createCollection("Theirs");
    await addSkill(readable, "triage", "triage", [{ path: "notes.md", body: "Notes.\n" }]);
    await addSkill(unreadable, "secret", "secret");
    let { session, authorized } = makeSession([readable]);

    await expect(session.readSkill(unreadable, "secret/SKILL.md"))
      .rejects.toThrow("No such skill in a collection you can read.");
    await expect(session.readSkill(readable, "triage/notes.md"))
      .rejects.toThrow("No such skill in a collection you can read.");
    expect(authorized).toEqual([]);
  });

  it("does not return the files of a skill nested inside it", async () => {
    let id = await createCollection("Mine");
    await addSkill(id, "triage", "triage", [{ path: "notes.md", body: "Notes.\n" }]);
    // A git-backed collection can hold one skill below another; the web editor refuses to make one.
    await collection(id).putContextDocument("triage/inner/SKILL.md", {
      description: "", body: manifest("inner"),
    });
    await collection(id).putContextDocument("triage/inner/x.md", { description: "", body: "x" });
    let { session } = makeSession([id]);

    let skill = await session.readSkill(id, "triage/SKILL.md");

    expect(skill.files.map(file => file.path)).toEqual(["SKILL.md", "notes.md"]);
    let listed = (await session.listSkills(id)).find(entry => entry.name === "triage");
    expect(listed?.fileCount).toBe(2);
  });
});

describe("LibraryReadSession reach", () => {
  it("offers no skills.sh or GitHub call to a gadget or an agent", () => {
    for (let name of ["searchSkillDirectory", "previewDirectorySkill", "readDirectorySkill", "importDirectorySkill"]) {
      expect(LibraryReadSession.prototype).not.toHaveProperty(name);
    }
  });
});
