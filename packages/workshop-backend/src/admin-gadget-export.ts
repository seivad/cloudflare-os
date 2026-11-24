// An admin's copy of a gadget (AdminWorkspaceView.exportGadget()): its code as a `.gadget`
// blueprint archive, which any Cloudflare OS takes in through Import blueprint, and, for
// "everything", that archive in a ZIP with the gadget's stored data (data.json) and a README that
// says what each file is. The Overseer reads the gadget (OverseerImpl.exportGadgetCopy()); what is
// here only builds files from what it read, writing nothing.

import type { BlueprintMetadata } from "@gadgets/workshop-shared/api";
import { zipFiles } from "@gadgets/workshop-shared/zip";
import { buildBlueprintArchiveStream } from "./blueprint-archive";
import { buildReleasePack, buildSnapshotRelease } from "./blueprint-release";

/**
 * A `.gadget` archive (version 2: metadata, then a release pack) of `files`, a gadget's committed
 * head. The release is the snapshot release of those files (buildSnapshotRelease()): a parentless
 * commit that depends on the files alone, so the copy carries none of the gadget's history, and
 * nothing is written to the workspace's git store to make it. `metadata` is the blueprint's, as
 * publishing would derive it; its commitId is the snapshot's.
 */
export async function buildGadgetArchive(files: ReadonlyMap<string, string>,
    metadata: Omit<BlueprintMetadata, "commitId">): Promise<Uint8Array> {
  let { commitId, objects } = buildSnapshotRelease(files);
  // Packed the way a published release is, which checks the files against everything an import
  // and an instantiation will demand of them.
  let pack = await buildReleasePack(oid => objects.get(oid), commitId);
  let archive = buildBlueprintArchiveStream(
      { ...metadata, commitId }, new Blob([pack]).stream(), pack.byteLength);
  return new Uint8Array(await new Response(archive).arrayBuffer());
}

/** What gadgetExportReadme() describes. */
export type GadgetExportDescription = {
  /** The gadget's title. */
  title: string;
  /** The name its files share (fileNameSlug() of the title). */
  slug: string;
  /** When the copy was taken. */
  exportedAt: Date;
};

/** The README.md of an "everything" copy: what each file is, and how each goes back in. */
export function gadgetExportReadme({ title, slug, exportedAt }: GadgetExportDescription): string {
  return `# ${title.replaceAll("\n", " ")}

A copy of a Cloudflare OS gadget, taken ${exportedAt.toISOString()}.

| File | What it is |
| --- | --- |
| \`${slug}.gadget\` | The gadget's code, as it was last accepted, as a blueprint. In any Cloudflare OS, **Import blueprint** takes it in, and a gadget made from it runs this code. Its connections are listed by name and kind, to be connected again; none is carried. |
| \`${slug}.data.json\` | The gadget's stored data: every table of its SQLite storage, with each table's \`CREATE TABLE\` statement and rows, and its key-value storage. |
| \`README.md\` | This file. |

## The data

\`${slug}.data.json\` is JSON, \`"format": "cloudflare-os/gadget-data"\`, \`"version": 1\`:

- \`gadget\`: the gadget's id and name in the workspace it came from.
- \`sizeBytes\`: the size of its storage when copied.
- \`sql\`: each table as \`{ "name", "createSql", "rows" }\`. The runtime's own tables (\`_cf_*\`,
  \`sqlite_*\`) are left out. A \`BLOB\` value is \`{ "$bytes": "<base64>" }\`; a number JSON
  cannot hold is \`{ "$number": "NaN" }\` (or \`"Infinity"\`, \`"-Infinity"\`, \`"-0"\`).
- \`kv\`: each key-value entry as \`{ "key", "value" }\`. A value JSON cannot hold as itself is an
  object with one \`$\`-prefixed key naming its kind (\`$bytes\`, \`$date\`, \`$map\`, \`$set\`,
  \`$bigint\` and others), and a stored object that has a key starting with \`$\` is wrapped as
  \`{ "$object": ... }\`.

Nothing imports the data yet: a gadget made from \`${slug}.gadget\` starts empty. To restore it,
recreate each table with its \`createSql\` and insert its rows, and put each key-value entry back,
from code running in the new gadget.
`;
}

/** What an "everything" copy holds: the code archive, data.json as the reader wrote it, and the
 * README. */
export type GadgetEverythingFiles = {
  /** The name the files share (fileNameSlug() of the gadget's title). */
  slug: string;
  /** The `.gadget` archive (buildGadgetArchive()). */
  archive: Uint8Array;
  /** The gadget's data.json: JSON text, or its UTF-8 bytes as the reader wrote them. */
  dataJson: string | Uint8Array;
  /** The README (gadgetExportReadme()). */
  readme: string;
};

/** The ZIP of an "everything" copy: `<slug>.gadget`, `<slug>.data.json` and `README.md`. */
export function zipGadgetEverything({ slug, archive, dataJson, readme }: GadgetEverythingFiles)
    : Promise<Uint8Array> {
  return zipFiles(new Map<string, string | Uint8Array>([
    [`${slug}.gadget`, archive],
    [`${slug}.data.json`, dataJson],
    ["README.md", readme],
  ]));
}
