// Repository archives from GitHub. Without a token, the gzipped tarball comes straight from
// codeload.github.com, which is not subject to the REST API's 60-requests-an-hour limit for
// unauthenticated callers (a limit Workers would share across one egress IP). With a token, the
// REST tarball endpoint is used instead: it redirects to a signed codeload URL and also reaches
// private repositories the token can read.

import { guardedFetch, type FetchLike } from "./http.js";
import { SkillDirectoryError, type GitHubRepository } from "./sources.js";

const CODELOAD_HOST = "codeload.github.com";
const API_HOST = "api.github.com";
const SERVICE = "GitHub";

export type ArchiveRequestOptions = {
  token?: string;
  signal: AbortSignal;
};

/** The gzipped tarball of `repository` at `ref`, which is "HEAD" or a validated commit SHA. */
export async function fetchRepositoryArchive(
    fetcher: FetchLike, repository: GitHubRepository, ref: string,
    options: ArchiveRequestOptions): Promise<ReadableStream<Uint8Array>> {
  let owner = encodeURIComponent(repository.owner);
  let repo = encodeURIComponent(repository.repo);
  let encodedRef = encodeURIComponent(ref);
  let request: { url: string; headers: Record<string, string>; hosts: ReadonlySet<string> } = options.token
    ? {
      url: `https://${API_HOST}/repos/${owner}/${repo}/tarball/${encodedRef}`,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      hosts: new Set([API_HOST]),
    }
    : {
      url: `https://${CODELOAD_HOST}/${owner}/${repo}/tar.gz/${encodedRef}`,
      headers: {},
      hosts: new Set([CODELOAD_HOST]),
    };
  let response = await guardedFetch(fetcher, {
    ...request,
    redirectHosts: new Set([CODELOAD_HOST]),
    signal: options.signal,
    service: SERVICE,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    let name = `${repository.owner}/${repository.repo}`;
    if (response.status === 404) {
      throw new SkillDirectoryError(`GitHub has no public repository or commit ${name}@${ref.slice(0, 12)}.`);
    }
    if (response.status === 403 || response.status === 429) {
      throw new SkillDirectoryError(options.token
        ? "GitHub is limiting requests from this deployment. Try again later."
        : "GitHub is limiting requests from this deployment. Try again later, or ask an administrator to set GITHUB_TOKEN.");
    }
    if (response.status === 401) {
      throw new SkillDirectoryError("GitHub rejected this deployment's GITHUB_TOKEN.");
    }
    throw new SkillDirectoryError(`GitHub could not send ${name} (HTTP ${response.status}).`);
  }
  return response.body;
}
