// Outbound requests to fixed hosts only. Redirects are followed by hand so that a response can never
// send a request, or its credentials, to a host the caller did not name.

import { SkillDirectoryError } from "./sources.js";

/** The subset of `fetch` the directory client uses; tests pass a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_REDIRECTS = 3;
const USER_AGENT = "cloudflare-os-skill-directory";

export type GuardedRequest = {
  url: string;
  headers?: Record<string, string>;
  /** Hosts the first request may go to. */
  hosts: ReadonlySet<string>;
  /** Hosts a redirect may lead to; credentials are dropped whenever the host changes. */
  redirectHosts: ReadonlySet<string>;
  signal: AbortSignal;
  /** Names the service in errors, e.g. "GitHub". */
  service: string;
};

function checkedUrl(url: string, hosts: ReadonlySet<string>, service: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SkillDirectoryError(`${service} returned an invalid address.`);
  }
  if (parsed.protocol !== "https:" || !hosts.has(parsed.hostname)
      || parsed.username || parsed.password || parsed.port) {
    throw new SkillDirectoryError(`${service} redirected to an address this deployment does not fetch from.`);
  }
  return parsed;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** Fetch `request.url`, following redirects only within `redirectHosts`. */
export async function guardedFetch(fetcher: FetchLike, request: GuardedRequest): Promise<Response> {
  let url = checkedUrl(request.url, request.hosts, request.service);
  let headers: Record<string, string> = { "User-Agent": USER_AGENT, ...request.headers };
  for (let redirects = 0; ; redirects++) {
    let response: Response;
    try {
      response = await fetcher(url.toString(), { headers, redirect: "manual", signal: request.signal });
    } catch (error) {
      if (isTimeout(error)) throw new SkillDirectoryError(`${request.service} did not respond in time.`);
      throw new SkillDirectoryError(`${request.service} could not be reached.`);
    }
    let location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    await response.body?.cancel();
    if (redirects >= MAX_REDIRECTS) {
      throw new SkillDirectoryError(`${request.service} redirected too many times.`);
    }
    let next = checkedUrl(new URL(location, url).toString(), request.redirectHosts, request.service);
    if (next.hostname !== url.hostname) {
      headers = { "User-Agent": USER_AGENT };
    }
    url = next;
  }
}

/** Read a response body as text, refusing bodies over `maxBytes`. */
export async function readLimitedText(
    response: Response, maxBytes: number, service: string): Promise<string> {
  let reader = response.body?.getReader();
  if (!reader) return "";
  let chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SkillDirectoryError(`${service} sent an unexpectedly large response.`);
    }
    chunks.push(value);
  }
  let bytes = new Uint8Array(total);
  let offset = 0;
  for (let chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Map a timeout raised while reading a body to the same message `guardedFetch` uses. */
export function rethrowAsDirectoryError(error: unknown, service: string): never {
  if (error instanceof SkillDirectoryError) throw error;
  if (isTimeout(error)) throw new SkillDirectoryError(`${service} did not respond in time.`);
  throw new SkillDirectoryError(`${service} sent a response that could not be read.`);
}
