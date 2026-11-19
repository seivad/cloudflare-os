import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type { GadgetClient, GadgetExportFormat } from "@gadgets/workshop-shared/api";

const mocks = vi.hoisted(() => ({
  saveStreamToFile: vi.fn<(
    createStream: () => Promise<ReadableStream<Uint8Array>>,
    filename: string,
    fileType: { description: string; contentType: string; extension: string },
  ) => Promise<void>>(),
}));

vi.mock("../../fileTransfers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../fileTransfers")>()),
  saveStreamToFile: mocks.saveStreamToFile,
}));

import { GadgetDownloadsHost } from "./gadgetDownloadsHost";

const VIDEO: GadgetExportFormat = { id: "file-1", label: "Video: a boat", mode: "server", contentType: "video/mp4", fileExtension: ".mp4", fileName: "video-a-boat.mp4" };
const CSV: GadgetExportFormat = { id: "csv", label: "CSV", mode: "server", contentType: "text/csv", fileExtension: ".csv" };

function host(options: { active?: boolean; allow?: boolean; chatId?: number } = {}) {
  const getExportFormats = vi.fn<(chatId?: number) => Promise<GadgetExportFormat[]>>(async () => [VIDEO, CSV]);
  const exportFormat = vi.fn<(id: string, chatId?: number) => Promise<ReadableStream<Uint8Array>>>(async () => new Response("bytes").body!);
  const askToSave = vi.fn<(fileName: string) => Promise<boolean>>(async () => options.allow ?? true);
  const gadget = { getExportFormats, export: exportFormat } as unknown as RpcStub<GadgetClient>;
  const h = new GadgetDownloadsHost({ gadget: () => gadget, chatId: options.chatId, title: () => "My Tracker", userActive: () => options.active ?? true, askToSave });
  return { h, getExportFormats, exportFormat, askToSave };
}

/** saveStreamToFile as it behaves once a destination is chosen: it fetches the stream. */
const saves = () => mocks.saveStreamToFile.mockImplementation(async (createStream) => { await createStream(); });

describe("a gadget's downloads", () => {
  beforeEach(() => {
    mocks.saveStreamToFile.mockReset();
  });

  it("saves one of the gadget's export formats under the format's own file name, after a click", async () => {
    saves();
    const { h, exportFormat, askToSave } = host({ chatId: 7 });
    expect(await h.save("file-1")).toBe(true);
    expect(mocks.saveStreamToFile).toHaveBeenCalledWith(expect.any(Function), "video-a-boat.mp4", { description: "Video: a boat", contentType: "video/mp4", extension: ".mp4" });
    // The frame shows a chat's proposed code, so that is the code exported.
    expect(exportFormat).toHaveBeenCalledWith("file-1", 7);
    expect(askToSave).not.toHaveBeenCalled();
  });

  it("names a file after the gadget where the format names none", async () => {
    saves();
    const { h } = host();
    await h.save("csv");
    expect(mocks.saveStreamToFile).toHaveBeenCalledWith(expect.any(Function), "My-Tracker.csv", expect.anything());
  });

  it("saves only what the gadget's export formats list", async () => {
    const { h, exportFormat } = host();
    await expect(h.save("secrets")).rejects.toThrow(/no export format with the id "secrets"/);
    for (const bad of ["", "x".repeat(129), 7, null, { id: "csv" }]) await expect(h.save(bad as string)).rejects.toThrow(/takes the id/);
    expect(exportFormat).not.toHaveBeenCalled();
    expect(mocks.saveStreamToFile).not.toHaveBeenCalled();
  });

  it("asks the person before a save that no click started, and saves nothing when they refuse", async () => {
    saves();
    const refused = host({ active: false, allow: false });
    expect(await refused.h.save("file-1")).toBe(false);
    expect(refused.askToSave).toHaveBeenCalledWith("video-a-boat.mp4");
    expect(mocks.saveStreamToFile).not.toHaveBeenCalled();
    const allowed = host({ active: false, allow: true });
    expect(await allowed.h.save("file-1")).toBe(true);
    expect(allowed.exportFormat).toHaveBeenCalledOnce();
  });

  it("answers false when the person closes the browser's save dialog", async () => {
    // Dismissed: saveStreamToFile returns without asking for the stream.
    mocks.saveStreamToFile.mockResolvedValue(undefined);
    const { h, exportFormat } = host();
    expect(await h.save("file-1")).toBe(false);
    expect(exportFormat).not.toHaveBeenCalled();
  });

  it("asks once and tries again when the browser no longer counts the click", async () => {
    mocks.saveStreamToFile.mockRejectedValueOnce(new DOMException("Must be handling a user gesture", "SecurityError"));
    mocks.saveStreamToFile.mockImplementationOnce(async (createStream) => { await createStream(); });
    const { h, askToSave } = host();
    expect(await h.save("file-1")).toBe(true);
    expect(askToSave).toHaveBeenCalledOnce();
    expect(mocks.saveStreamToFile).toHaveBeenCalledTimes(2);
  });

  it("passes on a failed export, and saves one file at a time", async () => {
    mocks.saveStreamToFile.mockImplementation(async (createStream) => { await createStream(); });
    const failing = host();
    failing.exportFormat.mockRejectedValue(new Error("Gadget export timed out."));
    await expect(failing.h.save("file-1")).rejects.toThrow(/timed out/);
    // It is free again after a failure.
    failing.exportFormat.mockResolvedValue(new Response("bytes").body!);
    expect(await failing.h.save("file-1")).toBe(true);

    const slow = host();
    let finish!: () => void;
    slow.getExportFormats.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve([VIDEO]); }));
    const first = slow.h.save("file-1");
    await expect(slow.h.save("file-1")).rejects.toThrow(/already being saved/);
    finish();
    expect(await first).toBe(true);
  });

  it("saves nothing once the gadget's page is closed", async () => {
    saves();
    const { h } = host();
    h[Symbol.dispose]();
    await expect(h.save("file-1")).rejects.toThrow(/was closed/);
    expect(mocks.saveStreamToFile).not.toHaveBeenCalled();
  });
});
