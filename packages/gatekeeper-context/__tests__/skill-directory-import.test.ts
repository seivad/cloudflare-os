import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { GatekeeperUserSelectionExchange } from "@gadgets/workshop-shared/gatekeeper";
import { ContextApiImpl } from "../src/context-api.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";
import {
  directoryPreview, importedContentType, importedSkillDocuments, skillDirectoryClient,
} from "../src/directory-import.js";
import { domainName } from "../src/domain.js";
import { SkillDirectoryClient } from "../src/skill-directory/index.js";
import { splitFrontmatter } from "../src/description-extractors.js";
import {
  archiveResponse, codeloadUrl, COMMIT, fakeFetch, manifest, repositoryArchive,
} from "./skill-directory-fixtures.js";

type TestEnv = {
  COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject>;
  USER_LIBRARIES: DurableObjectNamespace<UserLibraryDurableObject>;
  REGISTRIES: DurableObjectNamespace<LibraryRegistryDurableObject>;
};
const testEnv = env as unknown as TestEnv & Cloudflare.Env;

let domain = "";
let domains = 0;
let nextId = 0;
beforeEach(() => {
  domain = `directory-${domains++}.example`;
});

const collection = (id: string) =>
  testEnv.COLLECTIONS.get(testEnv.COLLECTIONS.idFromName(domainName(domain, id)));

function settled(rpc: PromiseLike<unknown>): Promise<unknown> {
  let { promise, resolve, reject } = Promise.withResolvers<unknown>();
  rpc.then(resolve, reject);
  return promise;
}

async function createCollection(options: { visibility?: "private" | "public"; owner?: string } = {}): Promise<string> {
  let id = `collection-${nextId++}`;
  let now = new Date();
  let visibility = options.visibility ?? "private";
  await collection(id).initialize({
    id, title: "Skills", description: "", visibility,
    created: now, lastUpdated: now, documentCount: 0, content: { source: "web" },
  }, domain, visibility === "private" ? options.owner ?? "alice" : "");
  return id;
}

/** A Git-backed collection owned by alice, over an Artifacts fake that only supports creation. */
async function createGitCollection(): Promise<string> {
  let id = `collection-${nextId++}`;
  let stub = collection(id);
  let artifacts = {
    async create(name: string) { return { remote: `https://artifacts.example/${name}.git`, token: "initial" }; },
    async get() { return { async revokeToken() { return true; } }; },
  } as unknown as Artifacts;
  await runInDurableObject(stub, (instance: ContextCollectionDurableObject) => {
    let object = instance as unknown as { env: Cloudflare.Env };
    object.env = { ...object.env, ARTIFACTS: artifacts };
  });
  let now = new Date();
  await stub.initialize({
    id, title: "Mirror", description: "", visibility: "private",
    created: now, lastUpdated: now, documentCount: 0,
    content: { source: "git", remote: "", branch: "main", lastRefreshedAt: now },
  }, domain, "alice");
  return id;
}

const SKILL_ENTRIES = [
  { path: "skills/frontend-design/LICENSE.txt", body: "Complete terms.\n" },
  {
    path: "skills/frontend-design/SKILL.md",
    body: "---\nname: frontend-design\ndescription: Distinctive frontend design.\nlicense: Complete terms in LICENSE.txt\nmetadata:\n  author: anthropic\n---\n\n# Frontend design\n\nKeep this   exactly.\r\n",
  },
  { path: "skills/frontend-design/assets/font.ttf", body: new Uint8Array([0, 1, 0, 0, 0xff]) },
  { path: "skills/frontend-design/reference/config.yaml", body: "description: Palette settings\ncolors: []\n" },
];

async function directoryFor(entries = SKILL_ENTRIES) {
  let archive = await repositoryArchive(entries);
  let fake = fakeFetch({ [codeloadUrl("anthropics/skills")]: archiveResponse(archive) });
  return { directory: new SkillDirectoryClient({ fetch: fake.fetch }), requests: fake.requests };
}

function api(accountId: string, directory: SkillDirectoryClient, isAdmin = false) {
  return new ContextApiImpl(
    testEnv, domain, accountId, isAdmin, testEnv.COLLECTIONS, testEnv.USER_LIBRARIES, testEnv.REGISTRIES,
    {} as Fetcher<GatekeeperUserSelectionExchange>, directory);
}

const file = (path: string, text: string | null) => ({ path, size: 1, bytes: new Uint8Array(1), text });

describe("skillDirectoryClient", () => {
  // Runs first in this file, so the isolate has no client yet, as on a fresh deployment.
  it("makes the isolate's client when no GITHUB_TOKEN is set", () => {
    let tokenless = { ...testEnv, GITHUB_TOKEN: undefined } as Cloudflare.Env;
    let client = skillDirectoryClient(tokenless);
    expect(client).toBeInstanceOf(SkillDirectoryClient);
    expect(skillDirectoryClient(tokenless)).toBe(client);
  });

  it("makes a new client when the token changes", () => {
    let tokenless = skillDirectoryClient({ ...testEnv, GITHUB_TOKEN: undefined } as Cloudflare.Env);
    let withToken = skillDirectoryClient({ ...testEnv, GITHUB_TOKEN: "token" } as Cloudflare.Env);
    expect(withToken).not.toBe(tokenless);
    expect(skillDirectoryClient({ ...testEnv, GITHUB_TOKEN: undefined } as Cloudflare.Env)).not.toBe(withToken);
  });
});

describe("directory import conversion", () => {
  it("records provenance in metadata and keeps the instructions byte for byte", async () => {
    let { directory } = await directoryFor();
    let bundle = await directory.resolve("anthropics/skills", "frontend-design");
    let documents = importedSkillDocuments(bundle, "design", new Date("2026-11-09T00:00:00.000Z"));
    let manifestDocument = documents[0];
    expect(manifestDocument.path).toBe("SKILL.md");
    expect(manifestDocument.description).toBe("Distinctive frontend design.");
    let { frontmatter, content } = splitFrontmatter(manifestDocument.body);
    expect(content).toBe("\n# Frontend design\n\nKeep this   exactly.\r\n");
    expect(parseYaml(frontmatter!)).toEqual({
      name: "design",
      description: "Distinctive frontend design.",
      license: "Complete terms in LICENSE.txt",
      metadata: {
        author: "anthropic",
        "imported-from": "skills.sh",
        "skills-sh-id": "anthropics/skills/frontend-design",
        "source-repository": "https://github.com/anthropics/skills",
        "source-path": "skills/frontend-design",
        "source-commit": COMMIT,
        "imported-at": "2026-11-09T00:00:00.000Z",
      },
    });
    expect(documents.slice(1).map(({ path, contentType, description }) => ({ path, contentType, description }))).toEqual([
      { path: "LICENSE.txt", contentType: "text/plain", description: "" },
      { path: "assets/font.ttf", contentType: "application/octet-stream", description: "" },
      { path: "reference/config.yaml", contentType: "application/yaml", description: "Palette settings" },
    ]);
    expect(documents[2].body).toBe("AAEAAP8=");
  });

  it("infers stored types without corrupting binary assets", () => {
    expect(importedContentType(file("notes.md", "x"))).toBe("text/markdown");
    expect(importedContentType(file("Makefile", "all:"))).toBe("text/plain");
    expect(importedContentType(file("font.woff2", null))).toBe("application/octet-stream");
    expect(importedContentType(file("data.json", null))).toBe("application/octet-stream");
    expect(importedContentType(file("logo.png", null))).toBe("image/png");
  });

  it("previews what Context would refuse to store", async () => {
    let { directory } = await directoryFor([
      { path: "skills/wordy/SKILL.md", body: manifest("wordy", "x".repeat(1100)) },
    ]);
    let preview = directoryPreview(await directory.resolve("anthropics/skills", "wordy"));
    expect(preview).toMatchObject({
      suggestedName: "wordy", commitSha: COMMIT, repoPath: "skills/wordy", files: [{ path: "SKILL.md" }],
    });
    expect(preview.blockers).toEqual(["Skill description must be at most 1024 characters."]);
  });

  it("suggests a valid name for a display-style frontmatter name", async () => {
    let { directory } = await directoryFor([
      { path: "skills/pdf-merge-split/SKILL.md", body: manifest("PDF Merge & Split") },
    ]);
    let preview = directoryPreview(await directory.resolve("anthropics/skills", "pdf-merge-split"));
    expect(preview).toMatchObject({ name: "PDF Merge & Split", suggestedName: "pdf-merge-split", blockers: [] });
  });
});

describe("atomic skill bundles", () => {
  const files = [
    { path: "SKILL.md", description: "A", body: manifest("bundle"), contentType: "text/markdown" },
    { path: "references/a.md", description: "", body: "# A\n" },
    { path: "assets/logo.png", description: "", body: "iVBORw0KGgo=", contentType: "image/png" },
  ];

  it("writes the manifest and every supporting file together", async () => {
    let id = await createCollection();
    await collection(id).createContextSkillBundle("bundle", files);
    let documents = await collection(id).listContextDocuments();
    expect(documents.map(document => document.path).toSorted())
      .toEqual(["bundle/SKILL.md", "bundle/assets/logo.png", "bundle/references/a.md"]);
    expect((await collection(id).getMetadata()).documentCount).toBe(3);
    expect((await collection(id).listAgentSkills()).map(skill => skill.skillName)).toEqual(["bundle"]);
    expect((await collection(id).getContextDocument("bundle/assets/logo.png"))?.body).toBe("iVBORw0KGgo=");
  });

  it("leaves nothing behind when the last file fails", async () => {
    let id = await createCollection();
    await expect(settled(collection(id).createContextSkillBundle("bundle", [
      ...files,
      { path: "assets/broken.png", description: "", body: "not base64!", contentType: "image/png" },
    ]))).rejects.toThrow("canonical base64");
    expect(await collection(id).listContextDocuments()).toEqual([]);
    expect(await collection(id).listAgentSkills()).toEqual([]);
    expect((await collection(id).getMetadata()).documentCount).toBe(0);

    await expect(settled(collection(id).createContextSkillBundle("bundle", [
      ...files,
      { path: "huge.txt", description: "", body: "x".repeat(1_900_000) },
    ]))).rejects.toThrow("too large");
    expect(await collection(id).listContextDocuments()).toEqual([]);
  });

  it("refuses conflicts, nested skills and unsafe paths without writing", async () => {
    let id = await createCollection();
    await collection(id).putContextDocument("legacy/README.md", { description: "", body: "Old layout" });
    await collection(id).createContextSkill("legacy/bundle-old/SKILL.md", {
      description: "", body: manifest("bundle"),
    });
    await expect(settled(collection(id).createContextSkillBundle("bundle", files)))
      .rejects.toThrow("A skill named “bundle” already exists in this collection.");
    await collection(id).putContextDocument("taken/notes.md", { description: "", body: "mine" });
    await expect(settled(collection(id).createContextSkillBundle("taken", [
      { path: "SKILL.md", description: "", body: manifest("taken") },
    ]))).rejects.toThrow("Skill directory already exists: taken");
    await expect(settled(collection(id).createContextSkillBundle("nest", [
      { path: "SKILL.md", description: "", body: manifest("nest") },
      { path: "inner/SKILL.md", description: "", body: manifest("inner") },
    ]))).rejects.toThrow("inside another skill");
    await expect(settled(collection(id).createContextSkillBundle("escape", [
      { path: "SKILL.md", description: "", body: manifest("escape") },
      { path: "../outside.md", description: "", body: "x" },
    ]))).rejects.toThrow("'..'");
    await expect(settled(collection(id).createContextSkillBundle("plain", [
      { path: "notes.md", description: "", body: "x" },
    ]))).rejects.toThrow("needs a SKILL.md");
    expect((await collection(id).listContextDocuments()).map(document => document.path).toSorted())
      .toEqual(["legacy/README.md", "legacy/bundle-old/SKILL.md", "taken/notes.md"]);
    expect((await collection(id).getContextDocument("taken/notes.md"))?.body).toBe("mine");
  });
});

describe("importDirectorySkill", () => {
  it("imports a previewed skill into an editable collection", async () => {
    let id = await createCollection();
    let { directory } = await directoryFor();
    let preview = await api("alice", directory).previewDirectorySkill("anthropics/skills", "frontend-design");
    expect(preview.blockers).toEqual([]);
    let result = await api("alice", directory)
      .importDirectorySkill(id, "anthropics/skills", "frontend-design", preview.commitSha);
    expect(result).toEqual({ manifestPath: "frontend-design/SKILL.md", name: "frontend-design", fileCount: 4 });
    let skill = await collection(id).getContextDocument("frontend-design/SKILL.md");
    expect(skill?.skillName).toBe("frontend-design");
    expect(skill?.body).toContain(`source-commit: ${COMMIT}`);
  });

  it("is refused to viewers before anything is fetched", async () => {
    let id = await createCollection();
    await collection(id).share("alice", [{ accountId: "bob", displayName: "bob" }], "viewer");
    let { directory, requests } = await directoryFor();
    await expect(api("bob", directory).importDirectorySkill(id, "anthropics/skills", "frontend-design", COMMIT))
      .rejects.toThrow("Collection not found or you don't have access.");
    await expect(api("mallory", directory).importDirectorySkill(id, "anthropics/skills", "frontend-design", COMMIT))
      .rejects.toThrow("Collection not found or you don't have access.");
    expect(requests).toEqual([]);
    expect(await collection(id).listContextDocuments()).toEqual([]);
  });

  it("is refused for Git-backed collections", async () => {
    let id = await createGitCollection();
    let { directory, requests } = await directoryFor();
    await expect(api("alice", directory).importDirectorySkill(id, "anthropics/skills", "frontend-design", COMMIT))
      .rejects.toThrow("Git-based collections are read-only");
    expect(requests).toEqual([]);
  });

  it("needs an admin to import into a public collection", async () => {
    let id = await createCollection({ visibility: "public" });
    let { directory } = await directoryFor();
    await expect(api("alice", directory).importDirectorySkill(id, "anthropics/skills", "frontend-design", COMMIT))
      .rejects.toThrow("Collection not found or you don't have access.");
    await api("admin", directory, true).importDirectorySkill(id, "anthropics/skills", "frontend-design", COMMIT);
    expect((await collection(id).listAgentSkills()).map(skill => skill.skillName)).toEqual(["frontend-design"]);
  });

  it("fails on a name conflict without overwriting, and imports under a new name", async () => {
    let id = await createCollection();
    await collection(id).createContextSkill("frontend-design/SKILL.md", {
      description: "Mine", body: manifest("frontend-design", "Mine"),
    });
    let { directory } = await directoryFor();
    await expect(api("alice", directory).importDirectorySkill(id, "anthropics/skills", "frontend-design", COMMIT))
      .rejects.toThrow("already exists");
    expect((await collection(id).getContextDocument("frontend-design/SKILL.md"))?.description).toBe("Mine");
    expect((await collection(id).getMetadata()).documentCount).toBe(1);

    await expect(api("alice", directory).importDirectorySkill(
      id, "anthropics/skills", "frontend-design", COMMIT, { name: "Bad Name" })).rejects.toThrow("lowercase");
    let result = await api("alice", directory).importDirectorySkill(
      id, "anthropics/skills", "frontend-design", COMMIT, { name: "frontend-design-2" });
    expect(result.manifestPath).toBe("frontend-design-2/SKILL.md");
    expect((await collection(id).listAgentSkills()).map(skill => skill.skillName).toSorted())
      .toEqual(["frontend-design", "frontend-design-2"]);
  });

  it("refuses a skill with blockers", async () => {
    let id = await createCollection();
    let { directory } = await directoryFor([
      { path: "skills/wordy/SKILL.md", body: manifest("wordy", "x".repeat(1100)) },
    ]);
    await expect(api("alice", directory).importDirectorySkill(id, "anthropics/skills", "wordy", COMMIT))
      .rejects.toThrow("at most 1024 characters");
    expect(await collection(id).listContextDocuments()).toEqual([]);
  });
});
