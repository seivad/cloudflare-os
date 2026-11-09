import { Banner, Button, LayerCard, Loader } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type {
  ContextDocumentSummary,
  DirectorySkillPreview,
  DirectorySkillSearchResult,
  EnabledCollectionInfo,
} from "../../src/context-types";
import { useContextApi } from "../bridge";
import { DirectorySkillImport, type DirectorySkillImportRequest } from "./DirectorySkillImport";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; preview: DirectorySkillPreview }
  | { status: "error"; message: string };

/** Reads a listed skill from its repository; `attempt` re-reads it. */
const useDirectorySkillPreview = (source: string, skillId: string, attempt: number): PreviewState => {
  const context = useContextApi();
  const [state, setState] = useState<{ attempt: number; value: PreviewState }>({
    attempt, value: { status: "loading" },
  });

  useEffect(() => {
    let cancelled = false;
    context.previewDirectorySkill(source, skillId).then(
      (preview) => { if (!cancelled) setState({ attempt, value: { status: "ready", preview } }); },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            attempt,
            value: { status: "error", message: error instanceof Error ? error.message : "The skill could not be read." },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [context, source, skillId, attempt]);

  return state.attempt === attempt ? state.value : { status: "loading" };
};

type SkillDirectoryPreviewProps = {
  result: DirectorySkillSearchResult;
  collections: readonly EnabledCollectionInfo[];
  writableCollections: readonly EnabledCollectionInfo[];
  documents: ReadonlyMap<string, readonly ContextDocumentSummary[]>;
  importing: boolean;
  onBack: () => void;
  onImport: (request: DirectorySkillImportRequest) => void;
};

/** Loads a skills.sh skill's preview, then offers to import it. */
export const SkillDirectoryPreview = ({
  result,
  importing,
  onBack,
  ...importProps
}: SkillDirectoryPreviewProps) => {
  const [attempt, setAttempt] = useState(0);
  const state = useDirectorySkillPreview(result.source, result.skillId, attempt);

  if (state.status === "ready") {
    return (
      <DirectorySkillImport
        key={state.preview.commitSha}
        preview={state.preview}
        importing={importing}
        onBack={onBack}
        {...importProps}
      />
    );
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-5 sm:px-6">
        {state.status === "loading" ? (
          <LayerCard
            role="status"
            aria-label={`Reading ${result.name} from ${result.source}`}
            className="flex min-h-[200px] items-center justify-center bg-kumo-control p-1"
          >
            <Loader />
          </LayerCard>
        ) : (
          <Banner
            variant="error"
            size="sm"
            icon={<WarningCircle weight="fill" />}
            title={`${result.name} could not be read`}
            description={state.message}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
        <Button variant="secondary" onClick={onBack}>Back</Button>
        {state.status === "error" && (
          <Button variant="primary" onClick={() => setAttempt((value) => value + 1)}>Try again</Button>
        )}
      </div>
    </>
  );
};
