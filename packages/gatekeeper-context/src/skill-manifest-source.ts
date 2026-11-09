// How imported Markdown is recognized as a skill manifest. Shared by the upload dialog, which
// converts browser files, and directory imports, which convert fetched SKILL.md files, so the two
// cannot disagree about where frontmatter ends and instructions begin.

import { isMap, parseDocument, type Document } from "yaml";
import { splitFrontmatter } from "./description-extractors.js";

/** A source's recognized frontmatter document (null for legacy Markdown) and the text after it. */
export type SkillManifestSource = { document: Document | null; content: string };

/**
 * Frontmatter is an import convention, not Markdown syntax. Only a complete YAML mapping
 * with a skill metadata key opts in; ambiguous or malformed blocks remain instruction text.
 * Both metadata inference and conversion must use this decision to avoid losing content.
 */
export const readSkillUploadSource = (body: string): SkillManifestSource => {
  const { frontmatter, content } = splitFrontmatter(body);
  if (frontmatter !== null) {
    const document = parseDocument(frontmatter);
    if (document.errors.length === 0 && isMap(document.contents)
      && (document.has("name") || document.has("description"))) {
      return { document, content };
    }
  }
  return { document: null, content: body };
};

/**
 * An imported manifest stored under `name`, with `metadata` entries merged into its frontmatter
 * `metadata` map (the Agent Skills field for client-defined properties). The text after the
 * frontmatter is kept byte for byte. Null when the source has no recognizable frontmatter.
 */
export const writeImportedSkillManifest = (
  body: string,
  name: string,
  metadata: Readonly<Record<string, string>>,
): string | null => {
  const { document, content } = readSkillUploadSource(body);
  if (document === null) return null;
  document.set("name", name);
  const existing = document.get("metadata", true);
  // A non-mapping `metadata` is invalid under the specification; it is replaced, not merged.
  const map = isMap(existing) ? existing : document.createNode({});
  for (const [key, value] of Object.entries(metadata)) map.set(key, value);
  document.set("metadata", map);
  return `---\n${document.toString({ lineWidth: 0 }).trimEnd()}\n---\n${content}`;
};
