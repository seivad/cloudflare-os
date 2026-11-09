// Strict validation for everything that ends up in a directory request URL. A skills.sh `source` is
// untrusted input from the browser and from skills.sh itself, so it is parsed into components that
// can only name a GitHub repository; nothing else ever reaches a URL.

/** A message meant for display: every failure this module throws is one. */
export class SkillDirectoryError extends Error {
  override name = "SkillDirectoryError";
}

/** A GitHub repository named by a skills.sh `source`. */
export type GitHubRepository = { owner: string; repo: string };

// GitHub account names: letters, digits and hyphens, not starting or ending with a hyphen.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// Repository names: letters, digits, '.', '_' and '-', except the path segments '.' and '..'.
const REPO_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
/** skills.sh skill ids are slugs of the skill's name (see `toSkillSlug`). */
const SKILL_ID_PATTERN = /^(?=.{1,128}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export const MIN_SEARCH_QUERY_LENGTH = 2;
const MAX_SEARCH_QUERY_LENGTH = 100;

/** The repository a skills.sh `source` names, or null when it is not a GitHub `owner/repo`. */
export function parseGitHubSource(source: string): GitHubRepository | null {
  if (typeof source !== "string") return null;
  let parts = source.split("/");
  if (parts.length !== 2) return null;
  let [owner, repo] = parts;
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) return null;
  return { owner, repo };
}

export function assertGitHubSource(source: string): GitHubRepository {
  let repository = parseGitHubSource(source);
  if (!repository) {
    throw new SkillDirectoryError("Only skills published from a GitHub repository can be imported.");
  }
  return repository;
}

export function isSkillId(skillId: string): boolean {
  return typeof skillId === "string" && SKILL_ID_PATTERN.test(skillId);
}

export function assertSkillId(skillId: string): void {
  if (!isSkillId(skillId)) throw new SkillDirectoryError("That skill id is not valid.");
}

export function isCommitSha(sha: string): boolean {
  return typeof sha === "string" && COMMIT_SHA_PATTERN.test(sha);
}

export function assertCommitSha(sha: string): void {
  if (!isCommitSha(sha)) throw new SkillDirectoryError("That commit is not a full Git commit SHA.");
}

/** Trimmed, whitespace-collapsed search text skills.sh accepts. */
export function normalizeSearchQuery(query: string): string {
  let normalized = typeof query === "string" ? query.trim().replace(/\s+/g, " ") : "";
  if (normalized.length < MIN_SEARCH_QUERY_LENGTH) {
    throw new SkillDirectoryError(`Search for at least ${MIN_SEARCH_QUERY_LENGTH} characters.`);
  }
  return normalized.slice(0, MAX_SEARCH_QUERY_LENGTH);
}

/**
 * The slug skills.sh derives a skill id from, given the skill's frontmatter name. Mirrors
 * `toSkillSlug` in the skills CLI (vercel-labs/skills `src/blob.ts`), which must match the server.
 */
export function toSkillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// C0/C1 controls and bidirectional overrides, which can disguise text shown to the operator.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Directory metadata as single-line display text, without characters that can disguise it. */
export function sanitizeDisplayText(text: string, maxLength: number): string {
  return text.replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
