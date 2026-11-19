// Saving a file for a gadget's page. A gadget's frame allows no downloads and may only reach the
// Workshop page, so the page saves on its behalf: the frame gets a `downloads` global (GadgetUI.tsx's
// injected code), an RPC stub to this object over its own MessagePort.
//
// What can be saved is one of the gadget's own export formats, the files the Export menu already
// offers: the frame names a format, and the Workshop page fetches and writes it as the menu does.
// The frame runs code the agent wrote, perhaps from someone else's blueprint, so it may not put a
// file on a person's device by itself: a save follows a click in the frame, and one that does not
// is put to the person first, in the Workshop's own UI.

import { RpcTarget, type RpcStub } from "capnweb";
import type { GadgetClient, GadgetExportFormat } from "@gadgets/workshop-shared/api";
import { makeExportFilename, saveStreamToFile } from "../../fileTransfers";

/** What the page hosting a gadget provides to this object. */
export type GadgetDownloadsDeps = {
  /** The gadget whose export formats may be saved. */
  gadget: () => RpcStub<GadgetClient>;
  /** The chat whose proposed code the frame is showing, when it is a preview of one. */
  chatId?: number;
  /** The gadget's title, for a format that names no file of its own. */
  title: () => string;
  /** Whether the person has just acted on the page: a click in the frame counts for a few seconds. */
  userActive: () => boolean;
  /** Asks the person whether this gadget may save `fileName`; resolves with their answer. */
  askToSave: (fileName: string) => Promise<boolean>;
};

const MAX_FORMAT_ID_LENGTH = 128;

/** Whether the browser refused to open its save dialog because the person's click was too long ago. */
const needsActivation = (error: unknown): boolean =>
  error instanceof DOMException && (error.name === "SecurityError" || error.name === "NotAllowedError");

export class GadgetDownloadsHost extends RpcTarget {
  #deps: GadgetDownloadsDeps;
  #saving = false;
  #disposed = false;

  constructor(deps: GadgetDownloadsDeps) {
    super();
    this.#deps = deps;
  }

  /**
   * Saves the gadget's export format `formatId` as a file on the person's device, as picking it in
   * the Export menu does. Answers true once it is saved and false when the person cancels.
   */
  async save(formatId: string): Promise<boolean> {
    if (typeof formatId !== "string" || formatId.length === 0 || formatId.length > MAX_FORMAT_ID_LENGTH) {
      throw new Error("downloads.save() takes the id of one of this Gadget's export formats.");
    }
    if (this.#disposed) throw new Error("This Gadget's page was closed.");
    if (this.#saving) throw new Error("A file is already being saved.");
    this.#saving = true;
    try {
      const formats = await this.#deps.gadget().getExportFormats(this.#deps.chatId);
      const format = formats.find((candidate) => candidate.id === formatId);
      if (!format) throw new Error(`This Gadget has no export format with the id ${JSON.stringify(formatId)}.`);
      const fileName = makeExportFilename(this.#deps.title(), format.fileExtension, format.fileName);
      let asked = false;
      if (!this.#deps.userActive()) {
        asked = true;
        if (!(await this.#deps.askToSave(fileName))) return false;
      }
      try {
        return await this.#write(format, fileName);
      } catch (error) {
        // The click that started this was spent while the formats were fetched: the person's
        // answer in the Workshop's own UI is a fresh one.
        if (asked || !needsActivation(error)) throw error;
        if (!(await this.#deps.askToSave(fileName))) return false;
        return await this.#write(format, fileName);
      }
    } finally {
      this.#saving = false;
    }
  }

  /** Writes one format to a file; false when the person closed the browser's save dialog. */
  async #write(format: GadgetExportFormat, fileName: string): Promise<boolean> {
    if (this.#disposed) return false;
    let started = false;
    await saveStreamToFile(
      () => {
        started = true;
        return this.#deps.gadget().export(format.id, this.#deps.chatId);
      },
      fileName,
      { description: format.label, contentType: format.contentType, extension: format.fileExtension },
    );
    // saveStreamToFile returns without fetching the file when the save dialog is dismissed.
    return started;
  }

  [Symbol.dispose](): void {
    this.#disposed = true;
  }
}
