// Repository archives from GitHub, for public repositories only.
//
// The gzipped tarball of a repository's default branch comes from codeload.github.com, which is not
// subject to the REST API's 60-requests-an-hour limit for unauthenticated callers (a limit Workers
// would share across one egress IP). Only the default branch is ever fetched: content for a commit is
// taken from such an archive, whose pax header names its commit, so a commit is only ever read from
// the public repository that was checked, never by SHA from elsewhere in its fork network.
//
// Without a token the request is anonymous, so GitHub itself serves public repositories only. A
// token raises rate limits, but codeload honours it for any repository the token can read, which
// would let any account read the deployment's private repositories through it. So, with a token,
// the repository's metadata must say it is public before the archive is requested, and again once
// the archive has been read; the archive is requested under the canonical name that check returned.

import { guardedFetch, readLimitedText, rethrowAsDirectoryError, type FetchLike } from "./http.js";
import { parseGitHubSource, SkillDirectoryError, type GitHubRepository } from "./sources.js";

const CODELOAD_HOSTS: ReadonlySet<string> = new Set(["codeload.github.com"]);
const API_HOSTS: ReadonlySet<string> = new Set(["api.github.com"]);
// Codeload does not redirect archive requests; refusing redirects keeps a token on codeload.
const NO_REDIRECTS: ReadonlySet<string> = new Set();
const SERVICE = "GitHub";
const MAX_METADATA_BYTES = 1_000_000;

export type ArchiveRequestOptions = {
  token?: string;
  signal: AbortSignal;
  /** Receives a refusal raised while the body streams, which a decompressor may not pass on intact. */
  onStreamError?: (error: SkillDirectoryError) => void;
};

const repositoryName = (repository: GitHubRepository) => `${repository.owner}/${repository.repo}`;

function notPublic(repository: GitHubRepository): SkillDirectoryError {
  return new SkillDirectoryError(
    `Only public GitHub repositories can be imported, and ${repositoryName(repository)} is private or does not exist.`);
}

function refusal(status: number, repository: GitHubRepository, hasToken: boolean): SkillDirectoryError {
  if (status === 404) return notPublic(repository);
  if (status === 401) return new SkillDirectoryError("GitHub rejected this deployment's GITHUB_TOKEN.");
  if (status === 403 || status === 429) {
    return new SkillDirectoryError(hasToken
      ? "GitHub is limiting requests from this deployment. Try again later."
      : "GitHub is limiting requests from this deployment. Try again later, or ask an administrator to set GITHUB_TOKEN.");
  }
  return new SkillDirectoryError(`GitHub could not send ${repositoryName(repository)} (HTTP ${status}).`);
}

/**
 * The canonical name of `repository` once its metadata, read with `token`, says it is public; a
 * private, internal or missing repository is refused.
 */
export async function confirmPublicRepository(
    fetcher: FetchLike, repository: GitHubRepository, token: string,
    signal: AbortSignal): Promise<GitHubRepository> {
  let response = await guardedFetch(fetcher, {
    url: `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    hosts: API_HOSTS,
    // A renamed repository answers with a redirect to its id on the same host.
    redirectHosts: API_HOSTS,
    signal,
    service: SERVICE,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw refusal(response.status, repository, true);
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readLimitedText(response, MAX_METADATA_BYTES, SERVICE));
  } catch (error) {
    rethrowAsDirectoryError(error, SERVICE);
  }
  let { private: isPrivate, visibility, full_name: fullName } = (metadata ?? {}) as Record<string, unknown>;
  if (isPrivate !== false || visibility !== "public") throw notPublic(repository);
  let canonical = typeof fullName === "string" ? parseGitHubSource(fullName) : null;
  if (!canonical) throw new SkillDirectoryError("GitHub described the repository in a way that could not be read.");
  return canonical;
}

const sameRepository = (left: GitHubRepository, right: GitHubRepository) =>
  repositoryName(left).toLowerCase() === repositoryName(right).toLowerCase();

/** The gzipped tarball of the default branch of `repository`, which must be public. */
export async function fetchPublicRepositoryArchive(
    fetcher: FetchLike, repository: GitHubRepository,
    options: ArchiveRequestOptions): Promise<ReadableStream<Uint8Array>> {
  let { token, signal, onStreamError } = options;
  let target = token ? await confirmPublicRepository(fetcher, repository, token, signal) : repository;
  let response = await guardedFetch(fetcher, {
    url: `https://codeload.github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/tar.gz/HEAD`,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    hosts: CODELOAD_HOSTS,
    redirectHosts: NO_REDIRECTS,
    signal,
    service: SERVICE,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw refusal(response.status, repository, !!token);
  }
  if (!token) return response.body;
  // Checked again once the archive has been read, so a repository made private while it downloaded
  // is refused rather than imported.
  return response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async flush() {
      try {
        let again = await confirmPublicRepository(fetcher, target, token, signal);
        if (!sameRepository(again, target)) throw notPublic(repository);
      } catch (error) {
        let refused = error instanceof SkillDirectoryError ? error : notPublic(repository);
        onStreamError?.(refused);
        throw refused;
      }
    },
  }));
}
