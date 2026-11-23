import { describe, expect, it } from "vitest";
import { fileNameSlug, zipFiles } from "@gadgets/workshop-shared/zip";
import { unzipBytes } from "./unzip.js";

describe("zipFiles", () => {
  it("keeps text and binary entries as they went in, in the order given", async () => {
    const binary = new Uint8Array(4096);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 7919) & 0xff;
    const files = new Map<string, string | Uint8Array>([
      ["notes/ünïcode ☃.md", "snow ☃ ".repeat(2000)],
      ["blob.bin", binary],
      ["empty.txt", ""],
      ["empty.bin", new Uint8Array(0)],
      // A view into a larger buffer: only its own bytes are stored.
      ["slice.bin", binary.subarray(10, 20)],
    ]);
    const entries = await unzipBytes(await zipFiles(files));
    expect([...entries.keys()]).toStrictEqual([...files.keys()]);
    const decoder = new TextDecoder();
    expect(decoder.decode(entries.get("notes/ünïcode ☃.md"))).toBe("snow ☃ ".repeat(2000));
    expect(entries.get("blob.bin")).toStrictEqual(binary);
    expect(decoder.decode(entries.get("empty.txt"))).toBe("");
    expect(entries.get("empty.bin")).toStrictEqual(new Uint8Array(0));
    expect(entries.get("slice.bin")).toStrictEqual(binary.slice(10, 20));
  });

  it("deflates what repeats", async () => {
    const archive = await zipFiles(new Map([["a.txt", "x".repeat(100_000)]]));
    expect(archive.byteLength).toBeLessThan(1000);
  });

  it("is an empty archive for no files", async () => {
    expect((await unzipBytes(await zipFiles(new Map()))).size).toBe(0);
  });
});

describe("fileNameSlug", () => {
  it("makes a file name of a title, falling back when the title has nothing to keep", () => {
    expect(fileNameSlug("Stock Take!")).toBe("stock-take");
    expect(fileNameSlug("Café Crème")).toBe("cafe-creme");
    expect(fileNameSlug("☃☃☃")).toBe("gadget");
    expect(fileNameSlug("☃", "workspace")).toBe("workspace");
    expect(fileNameSlug("a".repeat(60) + " b")).toBe("a".repeat(54));
  });
});
