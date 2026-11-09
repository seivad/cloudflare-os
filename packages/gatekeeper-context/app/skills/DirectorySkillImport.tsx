import { Banner, Button, Collapsible, Input, Label, LayerCard, Select, Text } from "@cloudflare/kumo";
import {
  CaretRight,
  DownloadSimple,
  FileText,
  GithubLogo,
  ShieldWarning,
  WarningCircle,
} from "@phosphor-icons/react";
import { useState } from "react";
import type {
  ContextDocumentSummary,
  DirectorySkillPreview,
  EnabledCollectionInfo,
} from "../../src/context-types";
import { formatFileSize, importNameConflict } from "./skillDirectory";
import { humanizeSkillName, isValidSkillName, sanitizeSkillTitle, skillNameFromTitle } from "./skillName";

/** What the operator chose to import, and where. */
export type DirectorySkillImportRequest = {
  preview: DirectorySkillPreview;
  collectionId: string;
  name: string;
};

type DirectorySkillImportProps = {
  preview: DirectorySkillPreview;
  collections: readonly EnabledCollectionInfo[];
  writableCollections: readonly EnabledCollectionInfo[];
  documents: ReadonlyMap<string, readonly ContextDocumentSummary[]>;
  importing: boolean;
  onBack: () => void;
  onImport: (request: DirectorySkillImportRequest) => void;
};

const CollectionLabel = ({ collection }: { collection: EnabledCollectionInfo }) => (
  <span className="flex items-center gap-2">
    {collection.icon ? <span>{collection.icon}</span> : null}
    <span className="truncate">{collection.title}</span>
  </span>
);

/** A previewed skills.sh skill: what it says, which files it brings, and where to import it. */
export const DirectorySkillImport = ({
  preview,
  collections,
  writableCollections,
  documents,
  importing,
  onBack,
  onImport,
}: DirectorySkillImportProps) => {
  const [title, setTitle] = useState(humanizeSkillName(preview.suggestedName));
  const [collectionId, setCollectionId] = useState(
    writableCollections.length === 1 ? writableCollections[0].id : "",
  );
  const [filesOpen, setFilesOpen] = useState(false);
  const name = skillNameFromTitle(title);
  const nameError = !isValidSkillName(name)
    ? "Enter a name using letters, numbers, spaces, or hyphens."
    : collectionId ? importNameConflict(documents, collectionId, name) ?? undefined : undefined;
  const blocked = preview.blockers.length > 0;
  const valid = !blocked && Boolean(collectionId) && !nameError;
  const location = [preview.source, preview.repoPath].filter(Boolean).join("/");

  return (
    <>
      {/* Sections keep their height so the column scrolls; the clipped cards would otherwise shrink. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 sm:px-6 [&>*]:shrink-0">
        <section aria-label="Skill details" className="flex flex-col gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-kumo-subtle">
            <GithubLogo aria-hidden size={14} className="shrink-0" />
            <span className="truncate">{location}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 font-mono" title={preview.commitSha}>
              commit {preview.commitSha.slice(0, 7)}
            </span>
          </div>
          <Text size="sm">{preview.description}</Text>
          <p className="flex items-center gap-1.5 text-xs text-kumo-subtle">
            <ShieldWarning aria-hidden size={14} className="shrink-0" />
            A skill is instructions your agents will follow. Read it before importing.
          </p>
        </section>

        {blocked && (
          <Banner
            variant="error"
            size="sm"
            icon={<WarningCircle weight="fill" />}
            title="This skill can't be imported"
            description={<span className="whitespace-pre-line">{preview.blockers.join("\n")}</span>}
          />
        )}

        <div className="flex flex-col gap-1.5">
          <span id="directory-skill-body-label"><Label>SKILL.md</Label></span>
          <pre
            aria-labelledby="directory-skill-body-label"
            tabIndex={0}
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-kumo-line bg-kumo-recessed p-3 font-mono text-xs leading-5 text-kumo-default"
          >
            {preview.body.trim() || "(No instructions after the frontmatter.)"}
          </pre>
        </div>

        <LayerCard className="overflow-hidden bg-kumo-control p-0">
          <Collapsible.Root open={filesOpen} onOpenChange={setFilesOpen}>
            <Collapsible.Trigger className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-kumo-tint">
              <FileText aria-hidden size={18} className="shrink-0 text-kumo-subtle" />
              <span className="flex-1 text-sm font-medium text-kumo-default">
                {preview.files.length} {preview.files.length === 1 ? "file" : "files"}
                <span className="font-normal text-kumo-subtle"> · {formatFileSize(preview.totalBytes)}</span>
                {preview.skipped.length > 0 && (
                  <span className="font-normal text-kumo-subtle"> · {preview.skipped.length} left out</span>
                )}
              </span>
              <CaretRight
                aria-hidden
                size={14}
                className={`shrink-0 text-kumo-inactive transition-transform ${filesOpen ? "rotate-90" : ""}`}
              />
            </Collapsible.Trigger>
            <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height,opacity] duration-100 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 [&[hidden]:not([hidden='until-found'])]:hidden">
              <ul aria-label="Files to import" className="max-h-56 overflow-y-auto border-t border-kumo-line py-1">
                {preview.files.map((file) => (
                  <li key={file.path} className="flex items-center gap-3 px-4 py-1 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono text-kumo-default">{file.path}</span>
                    <span className="shrink-0 tabular-nums text-kumo-subtle">{formatFileSize(file.size)}</span>
                  </li>
                ))}
              </ul>
              {preview.skipped.length > 0 && (
                <ul aria-label="Files left out" className="border-t border-kumo-line py-1">
                  {preview.skipped.map((file) => (
                    <li key={file.path} className="flex items-center gap-3 px-4 py-1 text-xs">
                      <span className="min-w-0 flex-1 truncate font-mono text-kumo-subtle line-through">{file.path}</span>
                      <span className="shrink-0 text-kumo-subtle">{file.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Collapsible.Panel>
          </Collapsible.Root>
        </LayerCard>

        {!blocked && (
          writableCollections.length === 0 ? (
            <Text variant="secondary" size="sm">
              Add a collection you can edit to import skills into.
            </Text>
          ) : (
            <div className="flex flex-col gap-4">
              <Input
                label="Name"
                description="Up to 64 letters, numbers, spaces, or hyphens."
                value={title}
                onChange={(event) => setTitle(sanitizeSkillTitle(event.target.value))}
                error={nameError}
                maxLength={64}
              />
              <Select
                label="Collection"
                className="w-full"
                placeholder="Select a collection"
                value={collectionId}
                onValueChange={(value) => setCollectionId(value as string)}
                renderValue={(id) => {
                  const collection = collections.find((candidate) => candidate.id === id);
                  return collection ? <CollectionLabel collection={collection} /> : "Select a collection";
                }}
              >
                {writableCollections.map((collection) => (
                  <Select.Option key={collection.id} value={collection.id}>
                    <CollectionLabel collection={collection} />
                  </Select.Option>
                ))}
              </Select>
            </div>
          )
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
        <Button variant="secondary" onClick={onBack} disabled={importing}>Back</Button>
        <Button
          variant="primary"
          icon={<DownloadSimple size={16} />}
          onClick={() => { if (valid && !importing) onImport({ preview, collectionId, name }); }}
          loading={importing}
          disabled={!valid}
        >
          Import
        </Button>
      </div>
    </>
  );
};
