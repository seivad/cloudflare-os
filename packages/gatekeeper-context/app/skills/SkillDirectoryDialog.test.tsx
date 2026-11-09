// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Toasty } from "@cloudflare/kumo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ContextApi,
  ContextDocumentSummary,
  DirectorySkillPreview,
  EnabledCollectionInfo,
} from "../../src/context-types";
import { SkillDirectoryDialog } from "./SkillDirectoryDialog";

const mocks = vi.hoisted(() => ({
  api: null as Partial<ContextApi> | null,
  onClose: null as (() => void) | null,
}));

vi.mock("../bridge", () => ({
  useContextApi: () => mocks.api,
  useResolvedThemeMode: () => "light",
}));

// Closing completes only when a test calls `mocks.onClose`, as the close transition would.
vi.mock("./useMutationDialog", () => ({
  useMutationDialog: (_busy: boolean, onClose: () => void) => {
    mocks.onClose = onClose;
    return {
      open: true,
      requestClose: () => mocks.onClose?.(),
      closeAfterSuccess: () => {},
      onOpenChangeComplete: () => {},
    };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.PointerEvent = MouseEvent as typeof PointerEvent;

const COMMIT = "2c5958ecac7cee2b583967a2c4981d0f4a75c579";

const collection = (id: string, title: string): EnabledCollectionInfo => ({
  id, title, description: "", source: "private", lastUpdated: new Date(),
});

const preview = (overrides: Partial<DirectorySkillPreview> = {}): DirectorySkillPreview => ({
  source: "anthropics/skills",
  skillId: "frontend-design",
  commitSha: COMMIT,
  repoPath: "skills/frontend-design",
  name: "frontend-design",
  suggestedName: "frontend-design",
  description: "Distinctive, intentional visual design.",
  body: "# Frontend design\n\nPick a bold direction.\n",
  files: [{ path: "SKILL.md", size: 9390 }, { path: "LICENSE.txt", size: 10174 }],
  skipped: [{ path: "link.md", reason: "Symbolic link" }],
  totalBytes: 19564,
  blockers: [],
  ...overrides,
});

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((candidate) => candidate.textContent?.includes(label));

const flush = () => act(async () => { await Promise.resolve(); });

const searchInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Search skills.sh"]')!;

const openFrontendDesign = async () => {
  await act(async () => { vi.advanceTimersByTime(300); });
  await flush();
  act(() => button("frontend-design")?.click());
  await flush();
};

describe("SkillDirectoryDialog", () => {
  let container: HTMLDivElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  const render = (props: {
    writableCollections?: EnabledCollectionInfo[];
    documents?: Map<string, ContextDocumentSummary[]>;
    onImported?: (collectionId: string, manifestPath: string) => void;
    onClose?: () => void;
    initialQuery?: string;
  } = {}) => {
    const collections = [collection("design", "Design"), collection("org", "Organization")];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(
      <Toasty>
        <SkillDirectoryDialog
          initialQuery={props.initialQuery ?? ""}
          collections={collections}
          writableCollections={props.writableCollections ?? [collections[0]]}
          documents={props.documents ?? new Map()}
          onImported={props.onImported ?? (() => {})}
          onClose={props.onClose ?? (() => {})}
        />
      </Toasty>,
    ));
  };

  it("debounces the search and lists name, repository and installs", async () => {
    const searchSkillDirectory = vi.fn<ContextApi["searchSkillDirectory"]>(async () => [
      { id: "anthropics/skills/frontend-design", source: "anthropics/skills", skillId: "frontend-design", name: "frontend-design", installs: 1_095_344, importable: true },
      { id: "smithery.ai/frontend-design", source: "smithery.ai", skillId: "frontend-design", name: "smithery design", installs: 6377, importable: false },
    ]);
    mocks.api = { searchSkillDirectory };
    render();

    act(() => setInputValue(searchInput(), "f"));
    act(() => setInputValue(searchInput(), "fro"));
    act(() => setInputValue(searchInput(), "frontend design"));
    await act(async () => { vi.advanceTimersByTime(299); });
    expect(searchSkillDirectory).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    await flush();

    expect(searchSkillDirectory.mock.calls).toEqual([["frontend design"]]);
    const results = document.querySelector('[aria-label="skills.sh results"]')!;
    expect(results.textContent).toContain("frontend-design");
    expect(results.textContent).toContain("anthropics/skills");
    expect(results.textContent).toContain("1.1M installs");
    expect(button("smithery design")?.disabled).toBe(true);
    expect(button("smithery design")?.textContent).toContain("Not on GitHub");
  });

  it("previews a skill and imports exactly the previewed commit, then selects it", async () => {
    const importDirectorySkill = vi.fn<ContextApi["importDirectorySkill"]>(async () => ({
      manifestPath: "frontend-design/SKILL.md", name: "frontend-design", fileCount: 2,
    }));
    mocks.api = {
      searchSkillDirectory: async () => [{ id: "anthropics/skills/frontend-design", source: "anthropics/skills", skillId: "frontend-design", name: "frontend-design", installs: 3, importable: true }],
      previewDirectorySkill: async () => preview(),
      importDirectorySkill,
    };
    const onImported = vi.fn<(collectionId: string, manifestPath: string) => void>();
    const onClose = vi.fn<() => void>();
    render({ initialQuery: "frontend", onImported, onClose });
    await openFrontendDesign();

    const text = document.body.textContent ?? "";
    expect(text).toContain("anthropics/skills/skills/frontend-design");
    expect(text).toContain("commit 2c5958e");
    expect(text).toContain("Distinctive, intentional visual design.");
    expect(text).toContain("A skill is instructions your agents will follow.");
    expect(document.querySelector("pre")?.textContent).toContain("Pick a bold direction.");
    expect(text).toContain("2 files");
    expect(text).toContain("1 left out");

    act(() => button("Import")?.click());
    await flush();
    expect(importDirectorySkill.mock.calls).toEqual([
      ["design", "anthropics/skills", "frontend-design", COMMIT, { name: "frontend-design" }],
    ]);
    expect(onImported).not.toHaveBeenCalled();
    act(() => mocks.onClose?.());
    expect(onClose).toHaveBeenCalled();
    expect(onImported).toHaveBeenCalledWith("design", "frontend-design/SKILL.md");
  });

  it("asks for a new name when the skill already exists in the target", async () => {
    const importDirectorySkill = vi.fn<ContextApi["importDirectorySkill"]>(async () => ({
      manifestPath: "frontend-design-2/SKILL.md", name: "frontend-design-2", fileCount: 2,
    }));
    mocks.api = {
      searchSkillDirectory: async () => [{ id: "a", source: "anthropics/skills", skillId: "frontend-design", name: "frontend-design", installs: 3, importable: true }],
      previewDirectorySkill: async () => preview(),
      importDirectorySkill,
    };
    render({
      initialQuery: "frontend",
      documents: new Map([["design", [{
        path: "frontend-design/SKILL.md", name: "SKILL.md", description: "", contentType: "text/markdown",
        skillName: "frontend-design", lastUpdated: new Date(),
      }]]]),
    });
    await openFrontendDesign();

    expect(document.body.textContent).toContain("A skill named “frontend-design” is already in this collection.");
    expect(button("Import")?.disabled).toBe(true);
    const nameInput = [...document.querySelectorAll<HTMLInputElement>("input")]
      .find((input) => input.value === "Frontend Design")!;
    act(() => setInputValue(nameInput, "Frontend Design 2"));
    expect(button("Import")?.disabled).toBe(false);
    act(() => button("Import")?.click());
    await flush();
    expect(importDirectorySkill.mock.calls[0]?.[4]).toEqual({ name: "frontend-design-2" });
  });

  it("refuses to import a blocked skill or without an editable collection", async () => {
    mocks.api = {
      searchSkillDirectory: async () => [{ id: "a", source: "anthropics/skills", skillId: "frontend-design", name: "frontend-design", installs: 3, importable: true }],
      previewDirectorySkill: async () => preview({ blockers: ["This skill is 5.5 MB; at most 5 MB can be imported."] }),
    };
    render({ initialQuery: "frontend" });
    await openFrontendDesign();
    expect(document.body.textContent).toContain("This skill can't be imported");
    expect(document.body.textContent).toContain("at most 5 MB");
    expect(button("Import")?.disabled).toBe(true);

    act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    mocks.api = { ...mocks.api, previewDirectorySkill: async () => preview() };
    render({ initialQuery: "frontend", writableCollections: [] });
    await openFrontendDesign();
    expect(document.body.textContent).toContain("Add a collection you can edit");
    expect(button("Import")?.disabled).toBe(true);
  });

  it("shows why a preview failed and retries it", async () => {
    let attempts = 0;
    mocks.api = {
      searchSkillDirectory: async () => [{ id: "a", source: "anthropics/skills", skillId: "frontend-design", name: "frontend-design", installs: 3, importable: true }],
      previewDirectorySkill: async () => {
        attempts++;
        if (attempts === 1) throw new Error("GitHub did not respond in time.");
        return preview();
      },
    };
    render({ initialQuery: "frontend" });
    await openFrontendDesign();
    expect(document.body.textContent).toContain("GitHub did not respond in time.");
    act(() => button("Try again")?.click());
    await flush();
    expect(document.body.textContent).toContain("Pick a bold direction.");
  });
});
