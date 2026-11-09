// Which SKILL.md in a repository is the skill skills.sh lists. These rules mirror the skills CLI that
// skills.sh is built around (vercel-labs/skills, `findSkillMdPaths` and `tryBlobInstall` in
// `src/blob.ts`, as of d3701c1), so an import picks the same directory `npx skills add` would.

import { toSkillSlug } from "./sources.js";

/**
 * Agent-specific project skill directories the CLI searches, besides `skills/` (its
 * `AGENT_PROJECT_SKILL_DIRS`). A snapshot: a directory missing here is still found by the
 * fallback search, at most five levels deep.
 */
const AGENT_SKILL_DIRS = [
  ".adal/skills", ".agents/skills", ".aider-desk/skills", ".augment/skills", ".autohand/skills",
  ".bob/skills", ".claude/skills", ".cline/skills", ".codeartsdoer/skills", ".codebuddy/skills",
  ".codemaker/skills", ".codestudio/skills", ".codex/skills", ".commandcode/skills",
  ".continue/skills", ".cortex/skills", ".crush/skills", ".devin/skills", ".factory/skills",
  ".forge/skills", ".github/skills", ".goose/skills", ".grok/skills", ".hermes/skills",
  ".iflow/skills", ".inferencesh/skills", ".jazz/skills", ".junie/skills", ".kilo/skills",
  ".kilocode/skills", ".kimchi/skills", ".kiro/skills", ".kode/skills", ".lingma/skills",
  ".mcpjam/skills", ".minimax/skills", ".moxby/skills", ".mux/skills", ".neovate/skills",
  ".ona/skills", ".opencode/skills", ".openhands/skills", ".pi/skills", ".pochi/skills",
  ".posit/assistant/skills", ".qoder/skills", ".qwen/skills", ".reasonix/skills", ".roo/skills",
  ".rovodev/skills", ".tabnine/agent/skills", ".terramind/skills", ".tinycloud/skills",
  ".trae/skills", ".vibe/skills", ".windsurf/skills", ".zcode/skills", ".zencoder/skills",
  "agent/skills", "data/skills",
];

const PRIORITY_PREFIXES = [
  "",
  "skills/",
  "skills/.curated/",
  "skills/.experimental/",
  "skills/.system/",
  ...AGENT_SKILL_DIRS.map(dir => `${dir}/`),
];

/** How deep below a known container directory a skill may sit, as in the CLI. */
const CONTAINER_DEPTH = 3;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);
/** The repository config whose `paths` declare extra skill container directories. */
export const SKILLS_SH_CONFIG_FILE = "skills.sh.json";

export const isManifestName = (fileName: string) => fileName.toLowerCase() === "skill.md";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The directory holding a manifest, "" at the repository root. */
export function manifestDirectory(manifestPath: string): string {
  let slash = manifestPath.lastIndexOf("/");
  return slash < 0 ? "" : manifestPath.slice(0, slash);
}

/** Extra container directories a `skills.sh.json` declares; anything invalid is ignored. */
export function parseSkillsShPaths(content: string): string[] {
  let config: unknown;
  try {
    config = JSON.parse(content);
  } catch {
    return [];
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) return [];
  let paths = (config as { paths?: unknown }).paths;
  if (!Array.isArray(paths)) return [];
  let result: string[] = [];
  for (let entry of paths) {
    if (typeof entry !== "string" || !entry.startsWith("./") || entry.includes("\\")) continue;
    let segments: string[] = [];
    let escapes = false;
    for (let segment of entry.slice(2).split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        if (segments.length === 0) escapes = true;
        segments.pop();
      } else {
        segments.push(segment);
      }
    }
    let normalized = segments.join("/");
    if (escapes || normalized === "" || result.includes(normalized)) continue;
    result.push(normalized);
  }
  return result;
}

/**
 * Every SKILL.md the CLI would offer from a repository, in its priority order: the root and known
 * container directories first, then, only if those hold none, any manifest at most five levels deep.
 */
export function findSkillManifestPaths(filePaths: readonly string[], extraContainers: readonly string[] = []): string[] {
  let manifests = filePaths.filter(path => isManifestName(baseName(path)));
  if (manifests.length === 0) return [];
  let lowerManifests = new Set(manifests.map(path => path.toLowerCase()));

  let extraPrefixes = new Set<string>();
  for (let dir of extraContainers) {
    let prefix = `${dir}/`;
    if (!PRIORITY_PREFIXES.includes(prefix)) extraPrefixes.add(prefix);
  }

  let results: string[] = [];
  let seen = new Set<string>();
  let add = (path: string) => {
    if (!seen.has(path)) {
      results.push(path);
      seen.add(path);
    }
  };
  for (let prefix of [...PRIORITY_PREFIXES, ...extraPrefixes]) {
    let isContainer = prefix !== "";
    let isExtraContainer = extraPrefixes.has(prefix);
    for (let manifest of manifests) {
      if (!manifest.startsWith(prefix)) continue;
      let rest = manifest.slice(prefix.length);
      if (isManifestName(rest)) {
        // Declared containers hold skills; a manifest directly inside one is not one of them.
        if (!isExtraContainer) add(manifest);
        continue;
      }
      let parts = rest.split("/");
      if (parts.length === 2) {
        add(manifest);
        continue;
      }
      let directories = parts.slice(0, -1);
      let hasAncestorSkill = directories.slice(0, -1).some((_, index) =>
        lowerManifests.has(`${prefix}${directories.slice(0, index + 1).join("/")}/skill.md`.toLowerCase()));
      if (isContainer && parts.length >= 3 && parts.length <= CONTAINER_DEPTH + 1
          && directories.every(part => !SKIP_DIRS.has(part)) && !hasAncestorSkill) {
        add(manifest);
      }
    }
  }
  if (results.length > 0) return results;
  return manifests.filter(path => path.split("/").length <= 6);
}

/** A discovered manifest and the frontmatter name it declares, if it declares a usable one. */
export type ManifestCandidate = { path: string; name: string | null };

/**
 * The manifest for `skillId` among `candidates` (in discovery order): a directory named after the
 * skill narrows the choice first, as in the CLI, then the frontmatter name decides. Null when
 * neither names the skill.
 */
export function selectSkillManifest(candidates: readonly ManifestCandidate[], skillId: string): string | null {
  let byFolder = candidates.filter(candidate => {
    let directory = manifestDirectory(candidate.path);
    return directory !== "" && toSkillSlug(baseName(directory)) === skillId;
  });
  let pool = byFolder.length > 0 ? byFolder : candidates;
  let byName = pool.filter(candidate => candidate.name !== null && toSkillSlug(candidate.name) === skillId);
  if (byName.length > 0) return byName[0].path;
  // A folder match stands even when its frontmatter names the skill differently, as in the CLI.
  let usableFolderMatch = byFolder.find(candidate => candidate.name !== null);
  return usableFolderMatch?.path ?? null;
}
