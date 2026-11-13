import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ObservationGate, type ObserverKv } from "@gadgets/gatekeeper-kit/observers";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { contextObserverStrategy } from "../src/context-observers.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import { LibraryReadSession } from "../src/library-read.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import { domainName } from "../src/domain.js";
import { SkillDirectoryClient } from "../src/skill-directory/index.js";
import {
  archiveResponse, codeloadUrl, COMMIT, fakeFetch, manifest, OTHER_COMMIT, repositoryArchive,
  type ArchiveEntry,
} from "./skill-directory-fixtures.js";

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

async function createCollection(title: string): Promise<string> {
  let id = `collection-${nextId++}`;
  let now = new Date();
  await collection(id).initialize({
    id, title, description: "", visibility: "private",
    created: now, lastUpdated: now, documentCount: 0, content: { source: "web" },
  }, domain, "owner");
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
function makeSession(library: string[], directory?: SkillDirectoryClient) {
  let authorized: ObservationDescription[] = [];
  let authorizer = {
    async authorizeObservation(description: ObservationDescription) { authorized.push(description); },
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
  let session = new LibraryReadSession(
    kvEnv, testEnv.COLLECTIONS, userLibraries, domain, "owner",
    new ObservationGate(
      authorizer as unknown as ConstructorParameters<typeof ObservationGate>[0],
      contextObserverStrategy(makeKv(), domain)),
    directory);
  return { session, authorized };
}

describe("LibraryReadSession.listSkills", () => {
  it("lists a skill from a readable collection and none from an unreadable one", async () => {
    let readable = await createCollection("Mine");
    let unreadable = await createCollection("Theirs");
    await addSkill(readable, "triage", "triage", [{ path: "notes.md", body: "Notes.\n" }]);
    await addSkill(unreadable, "secret", "secret");
    let { session, authorized } = makeSession([readable]);

    let skills = await session.listSkills();

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
    // Reading the index reveals the collection's contents, so the Workshop checks it for each viewer.
    expect(authorized).toEqual([expect.objectContaining({ subresources: [readable] })]);
  });

  it("changes a skill's revision when a file of it changes, and only then", async () => {
    let id = await createCollection("Mine");
    await addSkill(id, "triage", "triage");
    await addSkill(id, "other", "other");
    let { session } = makeSession([id]);
    let before = new Map((await session.listSkills()).map(skill => [skill.name, skill.revision]));

    await collection(id).putContextDocument("triage/notes.md", { description: "", body: "More.\n" });
    let after = new Map((await session.listSkills()).map(skill => [skill.name, skill.revision]));

    expect(after.get("triage")).not.toBe(before.get("triage"));
    expect(after.get("other")).toBe(before.get("other"));
  });

  it("observes nothing when the library holds no skill", async () => {
    let id = await createCollection("Docs");
    await collection(id).putContextDocument("plan.md", { description: "", body: "Plan.\n" });
    let { session, authorized } = makeSession([id]);

    expect(await session.listSkills()).toEqual([]);
    expect(authorized).toEqual([]);
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

  it("refuses a skill of more than 100 files with a sentence", async () => {
    let id = await createCollection("Mine");
    await addSkill(id, "triage", "triage", Array.from({ length: 100 }, (_, index) =>
      ({ path: `f${index}.md`, body: "x" })));
    let { session } = makeSession([id]);

    await expect(session.readSkill(id, "triage/SKILL.md"))
      .rejects.toThrow("This skill has 101 files; at most 100 are allowed.");
  });

  it("refuses a skill whose text totals more than 1 MB", async () => {
    let id = await createCollection("Mine");
    await addSkill(id, "triage", "triage", Array.from({ length: 5 }, (_, index) =>
      ({ path: `f${index}.txt`, body: "x".repeat(250 * 1024), contentType: "text/plain" })));
    let { session } = makeSession([id]);

    await expect(session.readSkill(id, "triage/SKILL.md"))
      .rejects.toThrow("This skill's text totals more than 1 MB.");
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
    let listed = (await session.listSkills()).find(entry => entry.name === "triage");
    expect(listed?.fileCount).toBe(2);
  });
});

const FRONTEND = "skills/frontend-design";
const ENTRIES: ArchiveEntry[] = [
  { path: `${FRONTEND}/SKILL.md`, body: manifest("frontend-design") },
  { path: `${FRONTEND}/reference/palette.md`, body: "Colours.\n" },
  { path: `${FRONTEND}/assets/font.ttf`, body: new Uint8Array([0, 1, 0, 0, 0xff]) },
];

async function directoryFor(entries: ArchiveEntry[] = ENTRIES, commit: string = COMMIT) {
  let archive = await repositoryArchive(entries, { commit });
  let fake = fakeFetch({ [codeloadUrl("anthropics/skills")]: archiveResponse(archive) });
  return { directory: new SkillDirectoryClient({ fetch: fake.fetch }), requests: fake.requests };
}

describe("LibraryReadSession directory calls", () => {
  it("searches skills.sh through the directory client", async () => {
    let fake = fakeFetch(url => url.startsWith("https://skills.sh/api/search")
      ? Response.json({ skills: [{
        id: "anthropics/skills/frontend-design", skillId: "frontend-design", name: "frontend-design",
        installs: 7, source: "anthropics/skills",
      }] })
      : undefined);
    let { session, authorized } = makeSession([], new SkillDirectoryClient({ fetch: fake.fetch }));

    let results = await session.searchSkillDirectory("frontend");

    expect(results).toEqual([expect.objectContaining({
      source: "anthropics/skills", skillId: "frontend-design", importable: true,
    })]);
    expect(fake.requests).toHaveLength(1);
    // Not library data: nothing is observed.
    expect(authorized).toEqual([]);
  });

  it("previews a skill as the management API does", async () => {
    let { directory } = await directoryFor();
    let { session } = makeSession([], directory);

    let preview = await session.previewDirectorySkill("anthropics/skills", "frontend-design");

    expect(preview).toMatchObject({
      source: "anthropics/skills", skillId: "frontend-design", commitSha: COMMIT, blockers: [],
      files: [
        { path: "SKILL.md", size: expect.any(Number) },
        { path: "reference/palette.md", size: 9 },
        { path: "assets/font.ttf", size: 5 },
      ],
    });
  });

  it("reads the files a preview lists, with their text, at the previewed commit", async () => {
    let { directory } = await directoryFor();
    let { session } = makeSession([], directory);
    let preview = await session.previewDirectorySkill("anthropics/skills", "frontend-design");

    let skill = await session.readDirectorySkill("anthropics/skills", "frontend-design", preview.commitSha);

    expect(skill.name).toBe("frontend-design");
    expect(skill.description).toBe("Use frontend-design.");
    expect(skill.revision).toBe(COMMIT);
    expect(skill.files).toEqual([
      { path: "SKILL.md", text: manifest("frontend-design") },
      { path: "reference/palette.md", text: "Colours.\n" },
    ]);
    // The font is in the preview's list but is not text.
    expect(skill.leftOut).toEqual([{ path: "assets/font.ttf", reason: "Not UTF-8 text." }]);
  });

  it("refuses when the repository has moved past the previewed commit", async () => {
    let { directory } = await directoryFor(ENTRIES, OTHER_COMMIT);
    let { session } = makeSession([], directory);

    await expect(session.readDirectorySkill("anthropics/skills", "frontend-design", COMMIT))
      .rejects.toThrow();
  });

  it("applies the same caps to a skills.sh skill", async () => {
    let many: ArchiveEntry[] = [
      { path: `${FRONTEND}/SKILL.md`, body: manifest("frontend-design") },
      ...Array.from({ length: 100 }, (_, index) =>
        ({ path: `${FRONTEND}/f${index}.md`, body: "x" })),
    ];
    let { directory } = await directoryFor(many);
    let { session } = makeSession([], directory);

    await expect(session.readDirectorySkill("anthropics/skills", "frontend-design", COMMIT))
      .rejects.toThrow("This skill has 101 files; at most 100 are allowed.");
  });

  it("leaves out a file over 256 KB", async () => {
    let { directory } = await directoryFor([
      ...ENTRIES,
      { path: `${FRONTEND}/big.txt`, body: "x".repeat(256 * 1024 + 1) },
    ]);
    let { session } = makeSession([], directory);

    let skill = await session.readDirectorySkill("anthropics/skills", "frontend-design", COMMIT);

    expect(skill.files.map(file => file.path)).toEqual(["SKILL.md", "reference/palette.md"]);
    expect(skill.leftOut).toContainEqual({ path: "big.txt", reason: "Over 256 KB." });
  });

  it("carries the client's skipped files (symlinks, nested skills) into leftOut", async () => {
    let { directory } = await directoryFor([
      ...ENTRIES,
      { path: `${FRONTEND}/link.md`, type: "symlink", target: "/etc/passwd" },
    ]);
    let { session } = makeSession([], directory);

    let skill = await session.readDirectorySkill("anthropics/skills", "frontend-design", COMMIT);

    expect(skill.files.map(file => file.path)).toEqual(["SKILL.md", "reference/palette.md"]);
    expect(skill.leftOut).toContainEqual({ path: "link.md", reason: "Symbolic link" });
  });
});
