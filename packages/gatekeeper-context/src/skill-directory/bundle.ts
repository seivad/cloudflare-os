// Turning a repository archive into one skill's bundle: discover the skill's directory, then collect
// the files below it under strict path rules and size limits. Archive contents are untrusted.

import {
  findSkillManifestPaths, isManifestName, manifestDirectory, parseSkillsShPaths,
  selectSkillManifest, SKILLS_SH_CONFIG_FILE,
} from "./discovery.js";
import { readSkillFrontmatter, type SkillFrontmatter } from "./manifest.js";
import { scanTar, type TarEntryType } from "./tar.js";
import {
  isCommitSha, SkillDirectoryError, toSkillSlug, type GitHubRepository,
} from "./sources.js";

export type BundleLimits = {
  /** Most files one skill may import, its manifest included. */
  maxFiles: number;
  /** Largest single file imported; larger files are skipped and reported. */
  maxFileBytes: number;
  /** Most bytes one skill may import in total. */
  maxTotalBytes: number;
};

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
  maxFiles: 200,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
};

/** One file a skill bundle imports. */
export type DirectorySkillFile = {
  /** Relative to the skill directory; the manifest is always "SKILL.md". */
  path: string;
  size: number;
  bytes: Uint8Array;
  /** The content when it is UTF-8 text without NUL bytes; null for binary content. */
  text: string | null;
};

/** A file below the skill directory that is not imported, and why. */
export type SkippedDirectoryFile = { path: string; reason: string };

/** One skill resolved from a repository at a commit. */
export type DirectorySkillBundle = {
  repository: GitHubRepository;
  skillId: string;
  commitSha: string;
  /** The skill's directory within the repository; "" when SKILL.md is at the root. */
  repoPath: string;
  frontmatter: SkillFrontmatter;
  /** The manifest's full text, as published. */
  manifestText: string;
  /** Path and size of every file the bundle imports, the manifest first. */
  files: { path: string; size: number }[];
  skipped: SkippedDirectoryFile[];
  totalBytes: number;
  /** Why the bundle cannot be imported; when empty, `contents` holds every file in `files`. */
  blockers: string[];
  contents: DirectorySkillFile[];
};

/** Where archives come from; the client caches and records them. */
export interface ArchiveSource {
  /**
   * The uncompressed tar stream of the repository at `ref`: "HEAD", or a commit SHA, for which the
   * stream may still hold another commit; the resolver checks the commit each archive names.
   */
  open(ref: string): Promise<ReadableStream<Uint8Array>>;
  /** Called after a stream from `open(ref)` was read to its end and found to hold commit `sha`. */
  scanned?(ref: string, sha: string): void;
}

const MAX_CONFIG_BYTES = 64 * 1024;
// Excluded exactly as the CLI's installer excludes them (`EXCLUDE_FILES`, `EXCLUDE_DIRS`).
const EXCLUDED_FILES = new Set(["metadata.json"]);
const EXCLUDED_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function decodeText(bytes: Uint8Array): string | null {
  try {
    let text = utf8.decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

type ListedEntry = { path: string; type: TarEntryType; size: number };

/**
 * Archive paths relative to the archive's single top-level directory, which `git archive` names
 * `<repo>-<ref>/`. A path that could escape it means the archive was not made by Git: refuse it.
 */
class ArchivePaths {
  #root: string | null = null;

  relative(path: string, type: TarEntryType): string | null {
    let trimmed = type === "directory" ? path.replace(/\/+$/, "") : path;
    let segments = trimmed.split("/");
    if (path.startsWith("/") || segments.some(segment => segment === "" || segment === "." || segment === "..")) {
      throw new SkillDirectoryError("The repository archive contains an unsafe path.");
    }
    this.#root ??= segments[0];
    if (segments[0] !== this.#root) {
      throw new SkillDirectoryError("The repository archive contains an unsafe path.");
    }
    return segments.length === 1 ? null : segments.slice(1).join("/");
  }
}

type ArchiveIndex = {
  commitSha: string | null;
  entries: ListedEntry[];
  /** Frontmatter of every readable manifest, for discovery. */
  manifestNames: Map<string, string | null>;
  /** Full text of manifests that could be the requested skill. */
  manifestTexts: Map<string, string>;
  extraContainers: string[];
};

function commitFromGlobalHeader(records: ReadonlyMap<string, string>): string | null {
  let comment = records.get("comment")?.trim() ?? "";
  return isCommitSha(comment) ? comment : null;
}

async function indexArchive(stream: ReadableStream<Uint8Array>, skillId: string, limits: BundleLimits): Promise<ArchiveIndex> {
  let paths = new ArchivePaths();
  let index: ArchiveIndex = {
    commitSha: null, entries: [], manifestNames: new Map(), manifestTexts: new Map(), extraContainers: [],
  };
  let relativePaths = new Map<string, string>();
  await scanTar(stream, {
    onGlobalHeader(records) {
      index.commitSha ??= commitFromGlobalHeader(records);
    },
    onEntry(entry) {
      let path = paths.relative(entry.path, entry.type);
      if (path === null) return null;
      relativePaths.set(entry.path, path);
      index.entries.push({ path, type: entry.type, size: entry.size });
      if (entry.type !== "file") return null;
      if (isManifestName(path.slice(path.lastIndexOf("/") + 1))) return limits.maxFileBytes;
      if (path === SKILLS_SH_CONFIG_FILE) return MAX_CONFIG_BYTES;
      return null;
    },
    onBody(entry, body) {
      let path = relativePaths.get(entry.path)!;
      let text = decodeText(body);
      if (path === SKILLS_SH_CONFIG_FILE) {
        index.extraContainers = text === null ? [] : parseSkillsShPaths(text);
        return;
      }
      let frontmatter = text === null ? null : readSkillFrontmatter(text);
      index.manifestNames.set(path, frontmatter?.name ?? null);
      let directory = manifestDirectory(path);
      let folder = directory.slice(directory.lastIndexOf("/") + 1);
      // Keep only the manifests that could be the one asked for; a catalog may hold hundreds.
      if (text !== null && frontmatter
          && (toSkillSlug(frontmatter.name) === skillId || (directory && toSkillSlug(folder) === skillId))) {
        index.manifestTexts.set(path, text);
      }
    },
  });
  return index;
}

type BundlePlan = {
  files: ListedEntry[];
  skipped: SkippedDirectoryFile[];
};

/** Which entries below the skill directory to import, and which to report as skipped. */
function planBundle(entries: readonly ListedEntry[], manifestPath: string, limits: BundleLimits): BundlePlan {
  let directory = manifestDirectory(manifestPath);
  let manifest = entries.find(entry => entry.path === manifestPath)!;
  // A root manifest has no directory of its own; like the CLI, import it alone rather than the
  // whole repository.
  if (directory === "") return { files: [{ ...manifest, path: "SKILL.md" }], skipped: [] };

  let prefix = `${directory}/`;
  let inside = entries
    .filter(entry => entry.path.startsWith(prefix))
    .map(entry => ({ ...entry, path: entry.path.slice(prefix.length) }));
  let nestedSkills = inside
    .filter(entry => entry.type === "file" && isManifestName(entry.path.slice(entry.path.lastIndexOf("/") + 1))
      && entry.path.includes("/"))
    .map(entry => manifestDirectory(entry.path));
  let nestedRoot = (path: string) => nestedSkills.find(root => path === root || path.startsWith(`${root}/`));
  let fileDirectories = new Set<string>();
  for (let entry of inside) {
    if (entry.type === "directory") continue;
    let parent = manifestDirectory(entry.path);
    while (parent) {
      fileDirectories.add(parent);
      parent = manifestDirectory(parent);
    }
  }

  let files: ListedEntry[] = [];
  let skipped: SkippedDirectoryFile[] = [];
  let reportedNested = new Set<string>();
  let manifestRelative = manifestPath.slice(prefix.length);
  for (let entry of inside) {
    let segments = entry.path.split("/");
    let nested = nestedRoot(entry.path);
    if (nested !== undefined) {
      if (!reportedNested.has(nested)) {
        reportedNested.add(nested);
        skipped.push({ path: `${nested}/`, reason: "Another skill; import it separately" });
      }
      continue;
    }
    if (entry.type === "directory") {
      // Git archives no empty directories, so one without files is a submodule's placeholder.
      if (!fileDirectories.has(entry.path)) skipped.push({ path: `${entry.path}/`, reason: "Git submodule" });
      continue;
    }
    if (segments.slice(0, -1).some(segment => EXCLUDED_DIRS.has(segment))
        || EXCLUDED_FILES.has(segments.at(-1)!)) {
      skipped.push({ path: entry.path, reason: "Not installed by the skills CLI" });
      continue;
    }
    if (entry.type === "symlink") {
      skipped.push({ path: entry.path, reason: "Symbolic link" });
      continue;
    }
    if (entry.type !== "file") {
      skipped.push({ path: entry.path, reason: entry.type === "hardlink" ? "Hard link" : "Unsupported file type" });
      continue;
    }
    if (entry.path === manifestRelative) {
      files.unshift({ ...entry, path: "SKILL.md" });
      continue;
    }
    if (entry.path === "SKILL.md") {
      skipped.push({ path: entry.path, reason: "Duplicate manifest" });
      continue;
    }
    if (CONTROL_CHARACTERS.test(entry.path)) {
      skipped.push({ path: entry.path, reason: "Unsupported file name" });
      continue;
    }
    if (entry.size > limits.maxFileBytes) {
      skipped.push({ path: entry.path, reason: `Larger than ${formatBytes(limits.maxFileBytes)}` });
      continue;
    }
    files.push(entry);
  }
  return { files, skipped };
}

/**
 * Resolve `skillId` in `repository` at `ref`: the commit, the skill's directory, its files and
 * anything that blocks importing it. When `ref` is a commit SHA the result is that commit's content
 * or a failure, never another commit's.
 */
export async function resolveDirectorySkill(
    source: ArchiveSource, repository: GitHubRepository, skillId: string, ref: string,
    limits: BundleLimits = DEFAULT_BUNDLE_LIMITS): Promise<DirectorySkillBundle> {
  let index = await indexArchive(await source.open(ref), skillId, limits);
  let commitSha = index.commitSha ?? (isCommitSha(ref) ? ref : null);
  if (!commitSha) throw new SkillDirectoryError("GitHub did not say which commit it sent.");
  if (isCommitSha(ref) && commitSha !== ref) {
    throw new SkillDirectoryError(
      "This skill has changed on GitHub since it was previewed. Preview it again to import the latest version.");
  }
  source.scanned?.(ref, commitSha);

  let repositoryName = `${repository.owner}/${repository.repo}`;
  let filePaths = index.entries.filter(entry => entry.type === "file").map(entry => entry.path);
  let candidates = findSkillManifestPaths(filePaths, index.extraContainers)
    .map(path => ({ path, name: index.manifestNames.get(path) ?? null }));
  let manifestPath = selectSkillManifest(candidates, skillId);
  let manifestText = manifestPath === null ? undefined : index.manifestTexts.get(manifestPath);
  let frontmatter = manifestText === undefined ? null : readSkillFrontmatter(manifestText);
  if (manifestPath === null || manifestText === undefined || frontmatter === null) {
    throw new SkillDirectoryError(`${repositoryName} has no skill “${skillId}” at commit ${commitSha.slice(0, 7)}.`);
  }

  let plan = planBundle(index.entries, manifestPath, limits);
  let totalBytes = plan.files.reduce((sum, file) => sum + file.size, 0);
  let blockers: string[] = [];
  if (plan.files.length > limits.maxFiles) {
    blockers.push(`This skill has ${plan.files.length} files; at most ${limits.maxFiles} can be imported.`);
  }
  if (totalBytes > limits.maxTotalBytes) {
    blockers.push(`This skill is ${formatBytes(totalBytes)}; at most ${formatBytes(limits.maxTotalBytes)} can be imported.`);
  }

  let bundle: DirectorySkillBundle = {
    repository,
    skillId,
    commitSha,
    repoPath: manifestDirectory(manifestPath),
    frontmatter,
    manifestText,
    files: plan.files.map(({ path, size }) => ({ path, size })),
    skipped: plan.skipped,
    totalBytes,
    blockers,
    contents: [],
  };
  if (blockers.length > 0) return bundle;

  let manifestBytes = encoder.encode(manifestText);
  bundle.contents.push({ path: "SKILL.md", size: manifestBytes.byteLength, bytes: manifestBytes, text: manifestText });
  let wanted = new Map(plan.files.slice(1).map(file => [
    bundle.repoPath ? `${bundle.repoPath}/${file.path}` : file.path, file.path,
  ]));
  if (wanted.size === 0) return bundle;

  let paths = new ArchivePaths();
  let found = new Map<string, Uint8Array>();
  let contentCommit: string | null = null;
  await scanTar(await source.open(commitSha), {
    onGlobalHeader(records) {
      contentCommit ??= commitFromGlobalHeader(records);
    },
    onEntry(entry) {
      let path = paths.relative(entry.path, entry.type);
      return path !== null && entry.type === "file" && wanted.has(path) ? limits.maxFileBytes : null;
    },
    onBody(entry, body) {
      found.set(wanted.get(entry.path.slice(entry.path.indexOf("/") + 1))!, body);
    },
  });
  if (contentCommit !== commitSha) {
    throw new SkillDirectoryError("The skill changed on GitHub while it was being read. Try again.");
  }
  for (let file of plan.files.slice(1)) {
    let bytes = found.get(file.path);
    if (!bytes) throw new SkillDirectoryError("The repository archive changed while it was being read.");
    bundle.contents.push({ path: file.path, size: bytes.byteLength, bytes, text: decodeText(bytes) });
  }
  return bundle;
}
