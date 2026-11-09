import { describe, expect, it } from "vitest";
import { findSkillManifestPaths, parseSkillsShPaths, selectSkillManifest } from "../src/skill-directory/discovery.js";
import { guardedFetch } from "../src/skill-directory/http.js";
import { SkillDirectoryClient } from "../src/skill-directory/index.js";
import { parseSkillsShSearchResponse } from "../src/skill-directory/skills-sh.js";
import {
  isCommitSha, isSkillId, normalizeSearchQuery, parseGitHubSource, toSkillSlug,
} from "../src/skill-directory/sources.js";
import {
  archiveResponse, codeloadUrl, COMMIT, fakeFetch, manifest, OTHER_COMMIT, repositoryArchive,
  type ArchiveEntry,
} from "./skill-directory-fixtures.js";

async function client(entries: ArchiveEntry[], options: {
  source?: string; commit?: string | null; limits?: ConstructorParameters<typeof SkillDirectoryClient>[0]["limits"];
} = {}) {
  let archive = await repositoryArchive(entries, { commit: options.commit });
  let source = options.source ?? "cloudflare/skills";
  let fake = fakeFetch({ [codeloadUrl(source)]: archiveResponse(archive) });
  return { directory: new SkillDirectoryClient({ fetch: fake.fetch, limits: options.limits }), ...fake };
}

describe("source validation", () => {
  it("accepts only GitHub owner/repo sources", () => {
    expect(parseGitHubSource("cloudflare/skills")).toEqual({ owner: "cloudflare", repo: "skills" });
    expect(parseGitHubSource("vercel-labs/agent-skills.v2_x")).toEqual({ owner: "vercel-labs", repo: "agent-skills.v2_x" });
    for (let source of [
      "smithery.ai", "docs.stripe.com", "a/b/c", "../x", "a/..", "a/.", "-a/b", "a-/b", "a/b?x=1",
      "a/b#frag", "@evil.com/x", "evil.com:443/x", "a/b%2F..", "a/b\\c", "a /b", "ａ/b", "", "a/",
      "/b", `${"a".repeat(40)}/b`,
    ]) {
      expect(parseGitHubSource(source), source).toBeNull();
    }
  });

  it("validates skill ids, commit SHAs and search text", () => {
    expect(isSkillId("frontend-design")).toBe(true);
    for (let id of ["Frontend", "a--b", "-a", "a-", "a/b", "../x", "a.b", ""]) expect(isSkillId(id), id).toBe(false);
    expect(isCommitSha(COMMIT)).toBe(true);
    for (let sha of ["HEAD", "main", COMMIT.slice(0, 12), COMMIT.toUpperCase(), `${COMMIT}0`, "../x"]) {
      expect(isCommitSha(sha), sha).toBe(false);
    }
    expect(normalizeSearchQuery("  frontend   design ")).toBe("frontend design");
    expect(() => normalizeSearchQuery(" a ")).toThrow("at least 2 characters");
  });

  it("derives slugs as skills.sh does", () => {
    expect(toSkillSlug("PDF Merge & Split")).toBe("pdf-merge-split");
    expect(toSkillSlug("react:components")).toBe("reactcomponents");
    expect(toSkillSlug("my_skill  name")).toBe("my-skill-name");
  });
});

describe("skills.sh search", () => {
  it("parses results and marks non-GitHub sources as not importable", () => {
    let results = parseSkillsShSearchResponse({
      query: "frontend design",
      skills: [
        { id: "anthropics/skills/frontend-design", source: "anthropics/skills", skillId: "frontend-design", name: "frontend-design", installs: 1_095_344 },
        { id: "smithery.ai/frontend-design", source: "smithery.ai", skillId: "frontend-design", name: "frontend-design", installs: 6377 },
        { source: "a/b", skillId: "x", name: "Spoof‮gnp.exe\u0007", installs: "lots" },
        { source: 42, skillId: "y" },
        "nonsense",
        { id: "anthropics/skills/frontend-design", source: "anthropics/skills", skillId: "frontend-design", name: "dupe", installs: 1 },
      ],
      count: 4,
    });
    expect(results).toEqual([
      { id: "anthropics/skills/frontend-design", source: "anthropics/skills", skillId: "frontend-design", name: "frontend-design", installs: 1_095_344, importable: true },
      { id: "smithery.ai/frontend-design", source: "smithery.ai", skillId: "frontend-design", name: "frontend-design", installs: 6377, importable: false },
      { id: "a/b/x", source: "a/b", skillId: "x", name: "Spoof gnp.exe", installs: 0, importable: true },
    ]);
    expect(() => parseSkillsShSearchResponse({ error: "Query must be at least 2 characters" }))
      .toThrow("could not be read");
  });

  it("queries skills.sh only, caches briefly, and reports refusals", async () => {
    let fake = fakeFetch((url) => {
      let parsed = new URL(url);
      if (parsed.searchParams.get("q")?.toLowerCase() === "wrangler") {
        return Response.json({ skills: [{ source: "cloudflare/skills", skillId: "wrangler", name: "wrangler", installs: 5 }] });
      }
      return Response.json({ error: "Query must be at least 2 characters" }, { status: 400 });
    });
    let directory = new SkillDirectoryClient({ fetch: fake.fetch });
    expect((await directory.search("Wrangler "))[0]?.skillId).toBe("wrangler");
    await directory.search("wrangler");
    expect(fake.requests).toHaveLength(1);
    let url = new URL(fake.requests[0].url);
    expect(`${url.origin}${url.pathname}`).toBe("https://skills.sh/api/search");
    expect(fake.requests[0].redirect).toBe("manual");
    await expect(directory.search("zz")).rejects.toThrow("did not accept that search");
    await expect(directory.search("x")).rejects.toThrow("at least 2 characters");
    expect(fake.requests).toHaveLength(2);
  });

  it("follows a redirect to www.skills.sh but nowhere else", async () => {
    let fake = fakeFetch((url) => {
      if (url.startsWith("https://skills.sh/")) {
        return new Response(null, { status: 308, headers: { location: url.replace("https://skills.sh", "https://www.skills.sh") } });
      }
      if (url.startsWith("https://www.skills.sh/")) {
        return Response.json({ skills: [] });
      }
      return undefined;
    });
    expect(await new SkillDirectoryClient({ fetch: fake.fetch }).search("redirected")).toEqual([]);

    let evil = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/api" } }));
    await expect(new SkillDirectoryClient({ fetch: evil.fetch }).search("redirected"))
      .rejects.toThrow("does not fetch from");
    expect(evil.requests.map(request => new URL(request.url).hostname)).toEqual(["skills.sh"]);
  });
});

describe("guarded fetch", () => {
  it("refuses hosts outside the allow list and drops credentials across hosts", async () => {
    let signal = AbortSignal.timeout(1000);
    let fake = fakeFetch((url) => url.startsWith("https://api.github.com/")
      ? new Response(null, { status: 302, headers: { location: "https://codeload.github.com/a/b/legacy.tar.gz/HEAD" } })
      : new Response("ok"));
    let request = {
      headers: { Authorization: "Bearer secret" },
      hosts: new Set(["api.github.com"]),
      redirectHosts: new Set(["codeload.github.com"]),
      signal,
      service: "GitHub",
    };
    await expect(guardedFetch(fake.fetch, { ...request, url: "https://evil.example/x" })).rejects.toThrow("does not fetch from");
    await expect(guardedFetch(fake.fetch, { ...request, url: "http://api.github.com/x" })).rejects.toThrow("does not fetch from");
    await expect(guardedFetch(fake.fetch, { ...request, url: "https://user@api.github.com/x" })).rejects.toThrow("does not fetch from");
    expect(fake.requests).toHaveLength(0);

    let response = await guardedFetch(fake.fetch, { ...request, url: "https://api.github.com/repos/a/b/tarball/HEAD" });
    expect(await response.text()).toBe("ok");
    expect(fake.requests.map(sent => sent.headers.authorization)).toEqual(["Bearer secret", undefined]);
  });
});

describe("skill discovery", () => {
  it("finds manifests in the CLI's priority directories before searching deeper", () => {
    expect(findSkillManifestPaths([
      "README.md", "skills/wrangler/SKILL.md", "skills/cloudflare/SKILL.md", "skills/cloudflare/references/x.md",
      "examples/deep/nested/demo/SKILL.md", ".claude/skills/local/SKILL.md", "skills/group/sub/leaf/SKILL.md",
    ])).toEqual([
      "skills/wrangler/SKILL.md", "skills/cloudflare/SKILL.md", "skills/group/sub/leaf/SKILL.md",
      ".claude/skills/local/SKILL.md",
    ]);
    expect(findSkillManifestPaths(["SKILL.md", "frontend-design/SKILL.md"])).toEqual(["SKILL.md", "frontend-design/SKILL.md"]);
    expect(findSkillManifestPaths(["a/b/c/d/e/SKILL.md", "a/b/c/d/e/f/SKILL.md"])).toEqual(["a/b/c/d/e/SKILL.md"]);
    expect(findSkillManifestPaths(["tools/kit/one/SKILL.md"], parseSkillsShPaths('{"paths":["./tools/kit/","../x","/abs","./"]}')))
      .toEqual(["tools/kit/one/SKILL.md"]);
  });

  it("selects by folder name first, then by frontmatter name", () => {
    let candidates = [
      { path: "skills/pdf-tools/SKILL.md", name: "PDF Tools" },
      { path: "skills/other/SKILL.md", name: "pdf-tools" },
      { path: "skills/sandbox-stable/SKILL.md", name: "sandbox-sdk" },
      { path: "SKILL.md", name: "root-skill" },
      { path: "skills/broken/SKILL.md", name: null },
    ];
    expect(selectSkillManifest(candidates, "pdf-tools")).toBe("skills/pdf-tools/SKILL.md");
    expect(selectSkillManifest(candidates, "sandbox-stable")).toBe("skills/sandbox-stable/SKILL.md");
    expect(selectSkillManifest(candidates, "root-skill")).toBe("SKILL.md");
    expect(selectSkillManifest(candidates, "broken")).toBeNull();
    expect(selectSkillManifest(candidates, "missing")).toBeNull();
  });
});

describe("skill bundles", () => {
  it("collects a skill directory at the archive's commit and reports what it leaves out", async () => {
    let binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    let { directory, requests } = await client([
      { path: "README.md", body: "# Repo\n" },
      { path: "skills/wrangler/SKILL.md", body: manifest("wrangler") },
      { path: "skills/cloudflare/LICENSE.txt", body: "MIT\n" },
      { path: "skills/cloudflare/SKILL.md", body: manifest("cloudflare") },
      { path: "skills/cloudflare/assets/logo.png", body: binary },
      { path: "skills/cloudflare/references/workers/README.md", body: "# Workers\n" },
      { path: "skills/cloudflare/metadata.json", body: "{}" },
      { path: "skills/cloudflare/__pycache__/x.pyc", body: "x" },
      { path: "skills/cloudflare/link.md", type: "symlink", target: "../../README.md" },
      { path: "skills/cloudflare/vendor", type: "directory" },
      { path: "skills/cloudflare/inner/SKILL.md", body: manifest("inner") },
      { path: "skills/cloudflare/inner/notes.md", body: "inner" },
      { path: "skills/cloudflare/big.bin", body: new Uint8Array(2048) },
      { path: `skills/cloudflare/references/${"long-name-".repeat(12)}.md`, body: "long path" },
    ], { limits: { maxFileBytes: 1024 } });

    let bundle = await directory.resolve("cloudflare/skills", "cloudflare");
    expect(bundle.commitSha).toBe(COMMIT);
    expect(bundle.repoPath).toBe("skills/cloudflare");
    expect(bundle.frontmatter).toMatchObject({ name: "cloudflare", description: "Use cloudflare." });
    expect(bundle.files.map(file => file.path)).toEqual([
      "SKILL.md", "LICENSE.txt", "assets/logo.png", "references/workers/README.md",
      `references/${"long-name-".repeat(12)}.md`,
    ]);
    expect(bundle.skipped).toEqual([
      { path: "metadata.json", reason: "Not installed by the skills CLI" },
      { path: "__pycache__/x.pyc", reason: "Not installed by the skills CLI" },
      { path: "link.md", reason: "Symbolic link" },
      { path: "vendor/", reason: "Git submodule" },
      { path: "inner/", reason: "Another skill; import it separately" },
      { path: "big.bin", reason: "Larger than 1 KB" },
    ]);
    expect(bundle.blockers).toEqual([]);
    let logo = bundle.contents.find(file => file.path === "assets/logo.png")!;
    expect(logo.text).toBeNull();
    expect([...logo.bytes]).toEqual([...binary]);
    expect(bundle.contents.find(file => file.path === "LICENSE.txt")?.text).toBe("MIT\n");
    // One download: the second read is served from the recorded archive.
    expect(requests.map(request => request.url)).toEqual([codeloadUrl("cloudflare/skills")]);

    // HEAD's commit is remembered briefly, and its archive kept, so another preview needs no
    // network. An import of the previewed commit reads the default branch afresh.
    await directory.resolve("cloudflare/skills", "wrangler");
    expect(requests).toHaveLength(1);
    expect((await directory.resolve("cloudflare/skills", "cloudflare", COMMIT)).contents).toHaveLength(5);
    expect(requests.map(request => request.url)).toEqual([codeloadUrl("cloudflare/skills"), codeloadUrl("cloudflare/skills")]);
  });

  it("imports only the manifest of a root-level skill", async () => {
    let { directory } = await client([
      { path: "SKILL.md", body: manifest("solo") },
      { path: "src/index.ts", body: "export {}" },
    ], { source: "someone/solo" });
    let bundle = await directory.resolve("someone/solo", "solo");
    expect(bundle.repoPath).toBe("");
    expect(bundle.files.map(file => file.path)).toEqual(["SKILL.md"]);
  });

  it("blocks bundles over the file and size limits", async () => {
    let { directory } = await client([
      { path: "skills/big/SKILL.md", body: manifest("big") },
      ...Array.from({ length: 4 }, (_, index) => ({ path: `skills/big/f${index}.md`, body: "x".repeat(600) })),
    ], { limits: { maxFiles: 3, maxTotalBytes: 1500 } });
    let bundle = await directory.resolve("cloudflare/skills", "big");
    expect(bundle.blockers).toEqual([
      "This skill has 5 files; at most 3 can be imported.",
      "This skill is 3 KB; at most 2 KB can be imported.",
    ]);
    expect(bundle.contents).toEqual([]);
  });

  it("refuses archives with paths that escape the repository", async () => {
    for (let path of ["../evil.md", "/etc/passwd", "skills/x/../../evil.md"]) {
      let { directory } = await client([{ path: "skills/x/SKILL.md", body: manifest("x") }, { path, body: "x" }]);
      await expect(directory.resolve("cloudflare/skills", "x"), path).rejects.toThrow("unsafe path");
    }
  });

  it("imports the previewed commit only while it is still the default branch", async () => {
    let archive = await repositoryArchive([{ path: "skills/x/SKILL.md", body: manifest("x") }], { commit: OTHER_COMMIT });
    let fake = fakeFetch({ [codeloadUrl("cloudflare/skills")]: archiveResponse(archive) });
    let directory = new SkillDirectoryClient({ fetch: fake.fetch });
    await expect(directory.resolve("cloudflare/skills", "x", COMMIT)).rejects.toThrow("changed on GitHub since it was previewed");
    expect((await directory.resolve("cloudflare/skills", "x", OTHER_COMMIT)).commitSha).toBe(OTHER_COMMIT);
    // Never fetched by SHA: a commit could otherwise come from elsewhere in the fork network.
    expect(fake.requests.every(request => !request.url.includes(COMMIT) && !request.url.includes(OTHER_COMMIT))).toBe(true);
  });

  it("explains a missing skill or repository without fetching for invalid input", async () => {
    let { directory, requests } = await client([{ path: "skills/x/SKILL.md", body: manifest("x") }]);
    await expect(directory.resolve("cloudflare/skills", "nope")).rejects.toThrow("has no skill “nope”");
    await expect(directory.resolve("evil.com/x", "x")).rejects.toThrow("GitHub repository");
    await expect(directory.resolve("cloudflare/skills", "../x")).rejects.toThrow("not valid");
    await expect(directory.resolve("cloudflare/skills", "x", "main")).rejects.toThrow("full Git commit");
    expect(requests).toHaveLength(1);
    await expect(new SkillDirectoryClient({ fetch: fakeFetch({}).fetch }).resolve("cloudflare/nothing", "x"))
      .rejects.toThrow("Only public GitHub repositories can be imported, and cloudflare/nothing is private or does not exist.");
  });

  it("rejects an archive that is not a repository archive", async () => {
    let fake = fakeFetch({ [codeloadUrl("cloudflare/skills")]: () => new Response("<html>nope</html>") });
    await expect(new SkillDirectoryClient({ fetch: fake.fetch }).resolve("cloudflare/skills", "x"))
      .rejects.toThrow("could not be read");
  });
});

const TOKEN = "github_pat_test";
const metadataUrl = (source: string) => `https://api.github.com/repos/${source}`;
const metadata = (fullName: string, visibility: "public" | "private" | "internal") => () =>
  Response.json({ full_name: fullName, private: visibility !== "public", visibility });

describe("public repositories only", () => {
  const entries = [{ path: "skills/x/SKILL.md", body: manifest("x") }];

  it("refuses a private repository without a token, anonymously", async () => {
    // Codeload answers an anonymous request for a private repository as if it did not exist.
    let fake = fakeFetch({});
    await expect(new SkillDirectoryClient({ fetch: fake.fetch }).resolve("acme/secret", "x"))
      .rejects.toThrow("Only public GitHub repositories can be imported, and acme/secret is private or does not exist.");
    expect(fake.requests.map(request => request.url)).toEqual([codeloadUrl("acme/secret")]);
    expect(fake.requests.every(request => request.headers.authorization === undefined)).toBe(true);
  });

  it("refuses a private or internal repository with a token, never requesting its archive", async () => {
    let archive = await repositoryArchive(entries);
    for (let visibility of ["private", "internal"] as const) {
      let fake = fakeFetch({
        [metadataUrl("acme/secret")]: metadata("acme/secret", visibility),
        [codeloadUrl("acme/secret")]: archiveResponse(archive),
      });
      let directory = new SkillDirectoryClient({ fetch: fake.fetch, githubToken: TOKEN });
      await expect(directory.resolve("acme/secret", "x"), visibility)
        .rejects.toThrow("Only public GitHub repositories can be imported, and acme/secret is private or does not exist.");
      await expect(directory.resolve("acme/secret", "x", COMMIT), visibility).rejects.toThrow("Only public GitHub repositories");
      expect(fake.requests.map(request => request.url)).toEqual([metadataUrl("acme/secret"), metadataUrl("acme/secret")]);
    }
    let missing = fakeFetch({});
    await expect(new SkillDirectoryClient({ fetch: missing.fetch, githubToken: TOKEN }).resolve("acme/gone", "x"))
      .rejects.toThrow("acme/gone is private or does not exist");
    expect(missing.requests.map(request => request.url)).toEqual([metadataUrl("acme/gone")]);
  });

  it("downloads a public repository under the token, by its canonical name, and checks again after", async () => {
    let archive = await repositoryArchive(entries);
    let fake = fakeFetch({
      [metadataUrl("old-owner/skills")]: () => new Response(null, {
        status: 301, headers: { location: "https://api.github.com/repositories/42" },
      }),
      "https://api.github.com/repositories/42": metadata("new-owner/skills", "public"),
      [metadataUrl("new-owner/skills")]: metadata("new-owner/skills", "public"),
      [codeloadUrl("new-owner/skills")]: archiveResponse(archive),
    });
    let bundle = await new SkillDirectoryClient({ fetch: fake.fetch, githubToken: TOKEN }).resolve("old-owner/skills", "x");
    expect(bundle.commitSha).toBe(COMMIT);
    expect(fake.requests.map(request => [request.url, request.headers.authorization])).toEqual([
      [metadataUrl("old-owner/skills"), `Bearer ${TOKEN}`],
      ["https://api.github.com/repositories/42", `Bearer ${TOKEN}`],
      [codeloadUrl("new-owner/skills"), `Bearer ${TOKEN}`],
      [metadataUrl("new-owner/skills"), `Bearer ${TOKEN}`],
    ]);
  });

  it("refuses, and keeps nothing, when a repository turns private while it downloads", async () => {
    let archive = await repositoryArchive(entries);
    let checks = 0;
    let fake = fakeFetch({
      [metadataUrl("acme/flip")]: () => metadata("acme/flip", checks++ === 0 ? "public" : "private")(),
      [codeloadUrl("acme/flip")]: archiveResponse(archive),
    });
    let directory = new SkillDirectoryClient({ fetch: fake.fetch, githubToken: TOKEN });
    await expect(directory.resolve("acme/flip", "x")).rejects.toThrow("acme/flip is private or does not exist");
    await expect(directory.resolve("acme/flip", "x")).rejects.toThrow("acme/flip is private or does not exist");
    // Nothing was cached from the refused download: the second attempt checked first and stopped.
    expect(fake.requests.map(request => request.url)).toEqual([
      metadataUrl("acme/flip"), codeloadUrl("acme/flip"), metadataUrl("acme/flip"), metadataUrl("acme/flip"),
    ]);
  });

  it("checks again on import, even when the previewed archive is cached", async () => {
    let archive = await repositoryArchive(entries);
    let visibility: "public" | "private" = "public";
    let fake = fakeFetch({
      [metadataUrl("acme/skills")]: () => metadata("acme/skills", visibility)(),
      [codeloadUrl("acme/skills")]: archiveResponse(archive),
    });
    let directory = new SkillDirectoryClient({ fetch: fake.fetch, githubToken: TOKEN });
    let preview = await directory.resolve("acme/skills", "x");
    visibility = "private";
    await expect(directory.resolve("acme/skills", "x", preview.commitSha)).rejects.toThrow("Only public GitHub repositories");
  });

  it("never follows a redirect away from the archive it asked for", async () => {
    let fake = fakeFetch({
      [codeloadUrl("acme/skills")]: () => new Response(null, {
        status: 302, headers: { location: "https://codeload.github.com/acme/private/legacy.tar.gz/HEAD?token=signed" },
      }),
    });
    await expect(new SkillDirectoryClient({ fetch: fake.fetch }).resolve("acme/skills", "x")).rejects.toThrow("does not fetch from");
    expect(fake.requests).toHaveLength(1);
  });
});
