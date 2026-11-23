// The files of an admin's copy of a gadget (admin-gadget-export.ts): the `.gadget` archive of its
// code, which reads back as Import blueprint reads it, and the "everything" ZIP around it. The
// Overseer's side, which reads the gadget and records the call, is in admin-workspace-view.test.ts
// and the integration suite's admin-gadget-export.test.ts.

import { describe, expect, it } from "vitest";
import type { BlueprintMetadata } from "@gadgets/workshop-shared/api";
import {
  buildGadgetArchive, gadgetExportReadme, zipGadgetEverything,
} from "../src/admin-gadget-export";
import { parseBlueprintArchive } from "../src/blueprint-archive";
import {
  buildSnapshotRelease, listReleaseFiles, readReleasePack,
} from "../src/blueprint-release";
import { unzipBytes } from "./unzip.js";

const FILES = new Map([
  ["server.js", "export class Gadget {}\n"],
  ["client.js", "document.body.append('hi');\n"],
  ["lib/words ☃.js", "export const a = 1;\n"],
]);

const EXPORTED_AT = new Date("2026-11-23T10:00:00.000Z");

const METADATA: Omit<BlueprintMetadata, "commitId"> = {
  title: "Team Notes",
  description: "",
  author: { type: "user", id: "owner@example.test", name: "Owner" },
  created: EXPORTED_AT,
  version: 1,
  lastUpdated: EXPORTED_AT,
  bindings: {
    REPO: {
      type: "gatekeeper", title: "Repo", description: "", gatekeeperName: "TestVendor",
      typeUrlPattern: "https://*",
    },
  },
  output: { id: "document", noun: "Document", plural: "Documents", icon: "fileText" },
};

async function readArchive(archive: Uint8Array) {
  let { metadata, contentLength, content } =
      await parseBlueprintArchive(new Blob([archive]).stream());
  let pack = new Uint8Array(await new Response(content).arrayBuffer());
  expect(pack.byteLength).toBe(contentLength);
  let objects = await readReleasePack(pack, metadata.commitId!);
  return { metadata, files: listReleaseFiles(objects, metadata.commitId!) };
}

describe("a gadget's code archive", () => {
  it("reads back as Import blueprint reads it: the metadata given, and the files", async () => {
    let { metadata, files } = await readArchive(await buildGadgetArchive(FILES, METADATA));
    // The release is the files' snapshot release, so any copy of the same files is one release.
    let { commitId } = buildSnapshotRelease(FILES);
    expect(metadata).toStrictEqual({ ...METADATA, commitId });
    expect(Object.fromEntries(files)).toStrictEqual(Object.fromEntries(FILES));
  });

  it("is a version 2 archive", async () => {
    let archive = await buildGadgetArchive(FILES, METADATA);
    expect(new DataView(archive.buffer, archive.byteOffset).getUint32(8)).toBe(2);
  });
});

describe("an everything copy", () => {
  it("holds the archive, the data as given, and a README naming both", async () => {
    let archive = await buildGadgetArchive(FILES, METADATA);
    let dataJson = JSON.stringify({ format: "cloudflare-os/gadget-data", version: 1, kv: [] });
    let readme = gadgetExportReadme(
        { title: "Team Notes", slug: "team-notes", exportedAt: EXPORTED_AT });
    let entries = await unzipBytes(
        await zipGadgetEverything({ slug: "team-notes", archive, dataJson, readme }));
    expect([...entries.keys()])
        .toStrictEqual(["team-notes.gadget", "team-notes.data.json", "README.md"]);
    expect(entries.get("team-notes.gadget")).toStrictEqual(archive);
    let decoder = new TextDecoder();
    expect(decoder.decode(entries.get("team-notes.data.json"))).toBe(dataJson);
    expect(decoder.decode(entries.get("README.md"))).toBe(readme);
  });

  it("has a README that says what each file is and that the data restores by hand", () => {
    let readme = gadgetExportReadme(
        { title: "Team\nNotes", slug: "team-notes", exportedAt: EXPORTED_AT });
    expect(readme.split("\n")[0]).toBe("# Team Notes");
    expect(readme).toContain("taken 2026-11-23T10:00:00.000Z");
    expect(readme).toContain("| `team-notes.gadget` |");
    expect(readme).toContain("**Import blueprint**");
    expect(readme).toContain("| `team-notes.data.json` |");
    expect(readme).toContain(`"format": "cloudflare-os/gadget-data"`);
    expect(readme).toContain("Nothing imports the data yet");
  });
});
