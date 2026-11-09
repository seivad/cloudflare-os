import { Button, Dialog, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowLeft, X } from "@phosphor-icons/react";
import { useState } from "react";
import type {
  ContextDocumentSummary,
  DirectorySkillSearchResult,
  EnabledCollectionInfo,
} from "../../src/context-types";
import { useContextApi } from "../bridge";
import type { DirectorySkillImportRequest } from "./DirectorySkillImport";
import { SkillDirectoryPreview } from "./SkillDirectoryPreview";
import { SkillDirectorySearch } from "./SkillDirectorySearch";
import { humanizeSkillName } from "./skillName";
import { useMutationDialog } from "./useMutationDialog";

type SkillDirectoryDialogProps = {
  initialQuery: string;
  collections: readonly EnabledCollectionInfo[];
  writableCollections: readonly EnabledCollectionInfo[];
  documents: ReadonlyMap<string, readonly ContextDocumentSummary[]>;
  /** Called once the dialog has closed after an import, with the new skill's location. */
  onImported: (collectionId: string, manifestPath: string) => void;
  onClose: () => void;
};

/** Searches skills.sh, previews a skill from its repository, and imports it into a collection. */
export const SkillDirectoryDialog = ({
  initialQuery,
  collections,
  writableCollections,
  documents,
  onImported,
  onClose,
}: SkillDirectoryDialogProps) => {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState<DirectorySkillSearchResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<{ collectionId: string; manifestPath: string } | null>(null);
  // Selecting the new skill navigates away from the navigator, so it waits until the dialog has
  // finished closing and released the full-viewport overlay.
  const dialog = useMutationDialog(importing, () => {
    onClose();
    if (imported) onImported(imported.collectionId, imported.manifestPath);
  });

  const importSkill = async ({ preview, collectionId, name }: DirectorySkillImportRequest) => {
    setImporting(true);
    try {
      const result = await context.importDirectorySkill(
        collectionId, preview.source, preview.skillId, preview.commitSha, { name },
      );
      toasts.add({ title: `Imported ${humanizeSkillName(result.name)}`, variant: "success" });
      setImported({ collectionId, manifestPath: result.manifestPath });
      dialog.closeAfterSuccess();
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "The skill could not be imported",
        variant: "error",
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog.Root
      open={dialog.open}
      onOpenChange={(open) => { if (!open) dialog.requestClose(); }}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
    >
      <Dialog className="top-[8%]! flex max-h-[84vh] w-[min(640px,calc(100vw-32px))]! translate-y-0! flex-col overflow-hidden bg-kumo-base p-0" size="lg">
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            {selected && (
              <Button
                variant="ghost"
                shape="square"
                aria-label="Back to results"
                disabled={importing}
                onClick={() => setSelected(null)}
              >
                <ArrowLeft size={18} />
              </Button>
            )}
            <Dialog.Title className="truncate text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
              {selected ? selected.name : "Browse skills.sh"}
            </Dialog.Title>
          </div>
          <Dialog.Close
            disabled={importing}
            render={(props) => (
              <Button {...props} variant="ghost" shape="square" aria-label="Close">
                <X size={18} />
              </Button>
            )}
          />
        </div>

        {selected ? (
          <SkillDirectoryPreview
            key={selected.id}
            result={selected}
            collections={collections}
            writableCollections={writableCollections}
            documents={documents}
            importing={importing}
            onBack={() => setSelected(null)}
            onImport={importSkill}
          />
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5 sm:px-6">
              <SkillDirectorySearch query={query} onQueryChange={setQuery} onSelect={setSelected} />
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
              <Button variant="secondary" onClick={dialog.requestClose}>Cancel</Button>
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  );
};
