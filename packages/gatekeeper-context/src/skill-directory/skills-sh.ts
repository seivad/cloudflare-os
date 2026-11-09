// The skills.sh search API: `GET https://skills.sh/api/search?q=<query>`. skills.sh has no content
// API, so it is used only to find skills; their files come from the GitHub repository in `source`.

import { guardedFetch, readLimitedText, rethrowAsDirectoryError, type FetchLike } from "./http.js";
import {
  isSkillId, parseGitHubSource, sanitizeDisplayText, SkillDirectoryError,
} from "./sources.js";

/** One skill skills.sh lists. */
export type SkillsShSkill = {
  /** skills.sh's identifier, `<source>/<skillId>`. */
  id: string;
  /** The publishing repository, `owner/repo`, or a host name for skills not published on GitHub. */
  source: string;
  skillId: string;
  name: string;
  installs: number;
  /** Whether `source` is a GitHub repository and `skillId` a valid id, so it can be fetched. */
  importable: boolean;
};

const SEARCH_URL = "https://skills.sh/api/search";
const SKILLS_SH_HOSTS: ReadonlySet<string> = new Set(["skills.sh", "www.skills.sh"]);
const SERVICE = "skills.sh";
const MAX_RESPONSE_BYTES = 1_000_000;
export const SEARCH_RESULT_LIMIT = 30;

function stringField(entry: Record<string, unknown>, key: string, maxLength: number): string | null {
  let value = entry[key];
  if (typeof value !== "string") return null;
  let text = sanitizeDisplayText(value, maxLength);
  return text || null;
}

/** The well-formed skills in a search response; malformed entries are dropped, not trusted. */
export function parseSkillsShSearchResponse(body: unknown): SkillsShSkill[] {
  if (typeof body !== "object" || body === null) {
    throw new SkillDirectoryError("skills.sh sent a search response that could not be read.");
  }
  let skills = (body as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) {
    throw new SkillDirectoryError("skills.sh sent a search response that could not be read.");
  }
  let results: SkillsShSkill[] = [];
  let seen = new Set<string>();
  for (let raw of skills.slice(0, SEARCH_RESULT_LIMIT * 2)) {
    if (typeof raw !== "object" || raw === null) continue;
    let entry = raw as Record<string, unknown>;
    let source = stringField(entry, "source", 200);
    let skillId = stringField(entry, "skillId", 200);
    if (!source || !skillId) continue;
    let id = `${source}/${skillId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let installs = typeof entry.installs === "number" && Number.isFinite(entry.installs)
      ? Math.max(0, Math.floor(entry.installs))
      : 0;
    results.push({
      id,
      source,
      skillId,
      name: stringField(entry, "name", 200) ?? skillId,
      installs,
      importable: parseGitHubSource(source) !== null && isSkillId(skillId),
    });
    if (results.length === SEARCH_RESULT_LIMIT) break;
  }
  return results;
}

/** Search skills.sh. `query` must already be normalized (see `normalizeSearchQuery`). */
export async function searchSkillsSh(
    fetcher: FetchLike, query: string, timeoutMs: number): Promise<SkillsShSkill[]> {
  let url = new URL(SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(SEARCH_RESULT_LIMIT));
  let signal = AbortSignal.timeout(timeoutMs);
  let response = await guardedFetch(fetcher, {
    url: url.toString(),
    headers: { Accept: "application/json" },
    hosts: SKILLS_SH_HOSTS,
    redirectHosts: SKILLS_SH_HOSTS,
    signal,
    service: SERVICE,
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) {
      throw new SkillDirectoryError("skills.sh is limiting searches right now. Try again in a minute.");
    }
    if (response.status === 400) {
      throw new SkillDirectoryError("skills.sh did not accept that search. Try different words.");
    }
    throw new SkillDirectoryError(`skills.sh search is unavailable (HTTP ${response.status}).`);
  }
  let text: string;
  try {
    text = await readLimitedText(response, MAX_RESPONSE_BYTES, SERVICE);
  } catch (error) {
    rethrowAsDirectoryError(error, SERVICE);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SkillDirectoryError("skills.sh sent a search response that could not be read.");
  }
  return parseSkillsShSearchResponse(body);
}
