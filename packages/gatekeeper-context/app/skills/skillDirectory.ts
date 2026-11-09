import type { ContextDocumentSummary } from "../../src/context-types";

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** "1.1M installs", as skills.sh presents install counts. */
export const formatInstalls = (installs: number): string =>
  `${compactNumber.format(installs)} ${installs === 1 ? "install" : "installs"}`;

/** A file size in bytes, KB or MB. */
export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
};

/**
 * Why a skill cannot be imported into `collectionId` as `name`, or null. Imports never overwrite:
 * the server refuses an existing skill name or anything at the new skill's directory, and this
 * mirrors that so the operator can rename first.
 */
export const importNameConflict = (
  documents: ReadonlyMap<string, readonly ContextDocumentSummary[]>,
  collectionId: string,
  name: string,
): string | null => {
  for (const document of documents.get(collectionId) ?? []) {
    if (document.skillName === name) return `A skill named “${name}” is already in this collection.`;
    if (document.path === name || document.path.startsWith(`${name}/`)) {
      return `“${name}” is already used in this collection.`;
    }
  }
  return null;
};
