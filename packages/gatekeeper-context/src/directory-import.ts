// Context's side of skills.sh imports: turning a directory bundle into a preview and into the
// documents of a new skill. The directory client (`skill-directory/`) fetches and validates the
// bundle; this module decides how Context stores it.

import { Buffer } from "node:buffer";
import { parseSkillManifest } from "./agent-skill.js";
import {
  contentTypeFromPath, isTextContentType, VENDOR_ID, type DirectorySkillPreview,
} from "./context-types.js";
import { extractDescription } from "./description-extractors.js";
import { obsContext } from "./observability.js";
import {
  SkillDirectoryClient, type DirectorySkillBundle, type DirectorySkillFile,
} from "./skill-directory/index.js";
import { writeImportedSkillManifest } from "./skill-manifest-source.js";

export const directoryLogger = obsContext.createLogger({
  component: "gatekeeper.context.directory", vendorId: VENDOR_ID,
});

const SKILL_NAME_MAX_LENGTH = 64;

let client: { token: string | undefined; instance: SkillDirectoryClient } | null = null;

/**
 * The isolate's directory client. One is shared by every account so its caches are too: it reads
 * public repositories only, with or without `GITHUB_TOKEN`, so nothing cached is private.
 */
export function skillDirectoryClient(env: Cloudflare.Env): SkillDirectoryClient {
  let token = env.GITHUB_TOKEN || undefined;
  // Compared explicitly: with no token, `client?.token !== token` is `undefined !== undefined`, so a
  // fresh isolate would never make its client.
  if (client === null || client.token !== token) {
    client = { token, instance: new SkillDirectoryClient({ githubToken: token }) };
  }
  return client.instance;
}

/** The name an import suggests: the skill id, within the skill-name length limit. */
export function suggestedSkillName(skillId: string): string {
  return skillId.slice(0, SKILL_NAME_MAX_LENGTH).replace(/-+$/, "");
}

/**
 * Where an imported skill came from, in its frontmatter `metadata` (string to string, as the Agent
 * Skills specification requires), so an update from the source can find it again.
 */
export function importProvenance(bundle: DirectorySkillBundle, importedAt: Date): Record<string, string> {
  let source = `${bundle.repository.owner}/${bundle.repository.repo}`;
  return {
    "imported-from": "skills.sh",
    "skills-sh-id": `${source}/${bundle.skillId}`,
    "source-repository": `https://github.com/${source}`,
    "source-path": bundle.repoPath || ".",
    "source-commit": bundle.commitSha,
    "imported-at": importedAt.toISOString(),
  };
}

/** The manifest an import stores under `name`; throws the reason it cannot be stored. */
function importedManifest(bundle: DirectorySkillBundle, name: string, importedAt: Date): string {
  let manifest = writeImportedSkillManifest(bundle.manifestText, name, importProvenance(bundle, importedAt));
  if (manifest === null) throw new Error("Its SKILL.md frontmatter could not be read.");
  parseSkillManifest(`${name}/SKILL.md`, manifest);
  return manifest;
}

/** A preview of `bundle`, including what would stop Context from storing it. */
export function directoryPreview(bundle: DirectorySkillBundle): DirectorySkillPreview {
  let suggestedName = suggestedSkillName(bundle.skillId);
  let blockers = [...bundle.blockers];
  try {
    importedManifest(bundle, suggestedName, new Date(0));
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : "Its SKILL.md is not a valid skill manifest.");
  }
  return {
    source: `${bundle.repository.owner}/${bundle.repository.repo}`,
    skillId: bundle.skillId,
    commitSha: bundle.commitSha,
    repoPath: bundle.repoPath,
    name: bundle.frontmatter.name,
    suggestedName,
    description: bundle.frontmatter.description,
    body: bundle.frontmatter.body,
    files: bundle.files,
    skipped: bundle.skipped,
    totalBytes: bundle.totalBytes,
    blockers,
  };
}

/**
 * How a fetched file is stored. Unknown extensions default to Markdown in Context, so, as uploads
 * do, their type is inferred from the content instead, and text types that are not valid text are
 * kept as bytes, so no asset is corrupted by being decoded as text.
 */
export function importedContentType(file: DirectorySkillFile): string {
  let pathType = contentTypeFromPath(file.path);
  if (pathType === "text/markdown" && !/\.(?:md|markdown)$/i.test(file.path)) {
    return file.text !== null ? "text/plain" : "application/octet-stream";
  }
  if (isTextContentType(pathType) && file.text === null) return "application/octet-stream";
  return pathType;
}

export type ImportedSkillDocument = { path: string; description: string; body: string; contentType: string };

/**
 * The documents of a skill imported from `bundle` under `name`, relative to its directory, the
 * manifest first. Throws when the bundle has blockers or its manifest cannot be stored.
 */
export function importedSkillDocuments(
    bundle: DirectorySkillBundle, name: string, importedAt: Date): ImportedSkillDocument[] {
  if (bundle.blockers.length > 0) throw new Error(bundle.blockers[0]);
  let manifest = importedManifest(bundle, name, importedAt);
  return bundle.contents.map((file) => {
    if (file.path === "SKILL.md") {
      return {
        path: file.path,
        description: parseSkillManifest(`${name}/SKILL.md`, manifest).description,
        body: manifest,
        contentType: "text/markdown",
      };
    }
    let contentType = importedContentType(file);
    let text = isTextContentType(contentType) ? file.text! : null;
    return {
      path: file.path,
      description: text === null ? "" : extractDescription(contentType, text) ?? "",
      body: text ?? Buffer.from(file.bytes).toString("base64"),
      contentType,
    };
  });
}
