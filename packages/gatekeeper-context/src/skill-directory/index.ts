// A client for the skills.sh directory: search skills.sh, then resolve a listed skill to a bundle of
// files from its GitHub repository at an exact commit. It knows nothing about where skills are
// stored; callers turn a bundle into their own documents.
//
// Every request goes to a fixed host (skills.sh, codeload.github.com, or api.github.com with a
// token), built only from validated components, with a timeout, and redirects are followed only to
// codeload.github.com (or www.skills.sh). Fetched content is untrusted: paths are confined to the
// skill's directory and sizes are capped (see `bundle.ts`).

import { ArchiveCache, TtlCache } from "./cache.js";
import {
  DEFAULT_BUNDLE_LIMITS, resolveDirectorySkill, type ArchiveSource, type BundleLimits,
  type DirectorySkillBundle,
} from "./bundle.js";
import { fetchRepositoryArchive } from "./github.js";
import { rethrowAsDirectoryError, type FetchLike } from "./http.js";
import { searchSkillsSh, type SkillsShSkill } from "./skills-sh.js";
import {
  assertCommitSha, assertGitHubSource, assertSkillId, isCommitSha, normalizeSearchQuery,
  SkillDirectoryError, type GitHubRepository,
} from "./sources.js";

export type { BundleLimits, DirectorySkillBundle, DirectorySkillFile, SkippedDirectoryFile } from "./bundle.js";
export type { FetchLike } from "./http.js";
export type { SkillsShSkill } from "./skills-sh.js";
export type { GitHubRepository } from "./sources.js";
export { DEFAULT_BUNDLE_LIMITS } from "./bundle.js";
export {
  isCommitSha, isSkillId, parseGitHubSource, SkillDirectoryError, toSkillSlug,
} from "./sources.js";

export type SkillDirectoryOptions = {
  fetch?: FetchLike;
  /** A GitHub token: archives then come through the REST API, under the token's rate limit. */
  githubToken?: string;
  limits?: Partial<BundleLimits>;
  now?: () => number;
};

const SEARCH_TIMEOUT_MS = 8_000;
const ARCHIVE_TIMEOUT_MS = 30_000;
const SEARCH_CACHE_TTL_MS = 60_000;
// A preview names the commit HEAD was at; re-resolving HEAD within this window reuses it.
const HEAD_CACHE_TTL_MS = 60_000;
const MiB = 1024 * 1024;
// A repository is downloaded whole, so bound it: compressed, expanded (against gzip bombs), and
// what is kept for the second read and later imports.
const MAX_ARCHIVE_BYTES = 64 * MiB;
const MAX_EXPANDED_BYTES = 256 * MiB;
const ARCHIVE_CACHE_BYTES = 24 * MiB;

type Recording = { chunks: Uint8Array[]; size: number; complete: boolean; overflowed: boolean };

/** Counts bytes through, failing past `maxBytes`, and keeps a copy while it fits `keepBytes`. */
function meter(maxBytes: number, message: string, recording: Recording | null, keepBytes: number,
    onLimit: (error: SkillDirectoryError) => void): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        let error = new SkillDirectoryError(message);
        onLimit(error);
        controller.error(error);
        return;
      }
      if (recording && !recording.overflowed) {
        if (total > keepBytes) {
          recording.overflowed = true;
          recording.chunks = [];
        } else {
          recording.chunks.push(chunk.slice());
          recording.size = total;
        }
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (recording) recording.complete = true;
    },
  });
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
  });
}

export class SkillDirectoryClient {
  #fetch: FetchLike;
  #token: string | undefined;
  #limits: BundleLimits;
  #searches: TtlCache<SkillsShSkill[]>;
  #heads: TtlCache<string>;
  #archives = new ArchiveCache(ARCHIVE_CACHE_BYTES);

  constructor(options: SkillDirectoryOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#token = options.githubToken || undefined;
    this.#limits = { ...DEFAULT_BUNDLE_LIMITS, ...options.limits };
    let now = options.now ?? Date.now;
    this.#searches = new TtlCache(SEARCH_CACHE_TTL_MS, 100, now);
    this.#heads = new TtlCache(HEAD_CACHE_TTL_MS, 100, now);
  }

  get limits(): BundleLimits {
    return this.#limits;
  }

  /** Skills matching `query`, most relevant first. */
  async search(query: string): Promise<SkillsShSkill[]> {
    let normalized = normalizeSearchQuery(query);
    let key = normalized.toLowerCase();
    let cached = this.#searches.get(key);
    if (cached) return cached;
    let results = await searchSkillsSh(this.#fetch, normalized, SEARCH_TIMEOUT_MS);
    this.#searches.set(key, results);
    return results;
  }

  /**
   * Resolve skill `skillId` published from `source` (`owner/repo`): at `commitSha` exactly, or at
   * the repository's default branch when it is omitted.
   */
  async resolve(source: string, skillId: string, commitSha?: string): Promise<DirectorySkillBundle> {
    let repository = assertGitHubSource(source);
    assertSkillId(skillId);
    if (commitSha !== undefined) assertCommitSha(commitSha);
    let repositoryKey = `${repository.owner}/${repository.repo}`.toLowerCase();
    let ref = commitSha ?? this.#heads.get(repositoryKey) ?? "HEAD";
    let limitError: SkillDirectoryError | null = null;
    try {
      return await resolveDirectorySkill(
        this.#archiveSource(repository, repositoryKey, error => { limitError = error; }),
        repository, skillId, ref, this.#limits);
    } catch (error) {
      rethrowAsDirectoryError(limitError ?? error, "GitHub");
    }
  }

  #archiveSource(repository: GitHubRepository, repositoryKey: string,
      onLimit: (error: SkillDirectoryError) => void): ArchiveSource {
    let recordings = new Map<string, Recording>();
    let expand = (compressed: ReadableStream<Uint8Array>) => compressed
      .pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(meter(MAX_EXPANDED_BYTES, "This repository is too large to import from.", null, 0, onLimit));
    return {
      open: async (ref) => {
        let cached = isCommitSha(ref) ? this.#archives.get(`${repositoryKey}@${ref}`) : undefined;
        if (cached) return expand(streamOf(cached));
        let compressed = await fetchRepositoryArchive(this.#fetch, repository, ref, {
          token: this.#token,
          signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
        });
        let recording: Recording = { chunks: [], size: 0, complete: false, overflowed: false };
        recordings.set(ref, recording);
        return expand(compressed.pipeThrough(meter(
          MAX_ARCHIVE_BYTES, "This repository is too large to import from.", recording,
          ARCHIVE_CACHE_BYTES / 2, onLimit)));
      },
      scanned: (ref, sha) => {
        let recording = recordings.get(ref);
        if (recording?.complete && !recording.overflowed) {
          this.#archives.set(`${repositoryKey}@${sha}`, recording.chunks, recording.size);
        }
        if (ref === "HEAD") this.#heads.set(repositoryKey, sha);
      },
    };
  }
}
