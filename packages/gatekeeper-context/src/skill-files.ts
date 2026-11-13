// The files of one skill as a gadget reads them: text only, under caps the gadget relies on. The
// same rules apply to a skill from the library and one from skills.sh.

import type { SkillFiles } from "./context-types.js";

export const SKILL_FILE_LIMITS = {
  /** Most files one skill may have, the ones left out included. */
  maxFiles: 100,
  /** Largest file whose text is returned. */
  maxFileBytes: 256 * 1024,
  /** Most bytes of text one skill may return in total. */
  maxTotalBytes: 1024 * 1024,
};

/** One file of a skill, as found: `text` is null when it is not UTF-8 text or is over the file cap. */
export type RawSkillFile = { path: string; size: number; text: string | null };

const MANIFEST = "SKILL.md";

/**
 * The files of a skill under the caps, SKILL.md first and the rest by path. Throws a sentence for a
 * skill that has too many files, whose text is too large in total, or whose SKILL.md is unusable.
 */
export function assembleSkillFiles(
    skill: { name: string; description: string; revision: string },
    raw: RawSkillFile[], alsoLeftOut: { path: string; reason: string }[] = []): SkillFiles {
  let { maxFiles, maxFileBytes, maxTotalBytes } = SKILL_FILE_LIMITS;
  if (raw.length > maxFiles) {
    throw new Error(`This skill has ${raw.length} files; at most ${maxFiles} are allowed.`);
  }
  let sorted = raw.toSorted((left, right) =>
    Number(right.path === MANIFEST) - Number(left.path === MANIFEST) ||
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  let files: SkillFiles["files"] = [];
  let leftOut: SkillFiles["leftOut"] = [];
  let total = 0;
  for (let file of sorted) {
    let reason = file.size > maxFileBytes ? `Over ${maxFileBytes / 1024} KB.`
        : file.text === null ? "Not UTF-8 text." : null;
    if (reason !== null) {
      if (file.path === MANIFEST) throw new Error(`This skill's SKILL.md is unusable: ${reason.toLowerCase()}`);
      leftOut.push({ path: file.path, reason });
      continue;
    }
    total += file.size;
    files.push({ path: file.path, text: file.text! });
  }
  if (total > maxTotalBytes) {
    throw new Error(`This skill's text totals more than ${maxTotalBytes / (1024 * 1024)} MB.`);
  }
  if (files[0]?.path !== MANIFEST) throw new Error("This skill has no SKILL.md.");
  return { ...skill, files, leftOut: [...leftOut, ...alsoLeftOut] };
}
