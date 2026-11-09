// Reading SKILL.md frontmatter the way the skills CLI does (`parseFrontmatter` in its
// `src/frontmatter.ts`), so a manifest the CLI accepts names the same skill here.

import { parse as parseYaml } from "yaml";
import { sanitizeDisplayText } from "./sources.js";

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export type SkillFrontmatter = {
  /** The frontmatter `name`, as single-line text. */
  name: string;
  /** The frontmatter `description`, as single-line text. */
  description: string;
  /** Everything after the closing `---` line. */
  body: string;
};

/**
 * The name, description and body of a manifest, or null when its frontmatter is missing, is not a
 * YAML mapping, or lacks a string `name` or `description` (the CLI skips such manifests).
 */
export function readSkillFrontmatter(text: string): SkillFrontmatter | null {
  let match = FRONTMATTER_RE.exec(text);
  if (!match) return null;
  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  let { name, description } = data as Record<string, unknown>;
  if (typeof name !== "string" || typeof description !== "string") return null;
  let safeName = sanitizeDisplayText(name, 200);
  let safeDescription = sanitizeDisplayText(description, 4096);
  if (!safeName || !safeDescription) return null;
  return { name: safeName, description: safeDescription, body: match[2] ?? "" };
}
