import { Badge, Banner, Input, LayerCard, Loader, Text } from "@cloudflare/kumo";
import { CaretRight, MagnifyingGlassIcon, ScrollIcon, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { DirectorySkillSearchResult } from "../../src/context-types";
import { useContextApi } from "../bridge";
import { formatInstalls } from "./skillDirectory";

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

type CompletedSearch =
  | { query: string; results: DirectorySkillSearchResult[] }
  | { query: string; error: string };

/** The latest completed skills.sh search for `query`, debounced; stale responses are dropped. */
const useSkillDirectorySearch = (query: string) => {
  const context = useContextApi();
  const [completed, setCompleted] = useState<CompletedSearch | null>(null);

  useEffect(() => {
    if (query.length < MIN_QUERY_LENGTH) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      context.searchSkillDirectory(query).then(
        (results) => { if (!cancelled) setCompleted({ query, results }); },
        (error: unknown) => {
          if (!cancelled) {
            setCompleted({ query, error: error instanceof Error ? error.message : "skills.sh search failed." });
          }
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [context, query]);

  return completed?.query === query ? completed : null;
};

type SkillDirectorySearchProps = {
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (result: DirectorySkillSearchResult) => void;
};

/** Search field and results for the skills.sh directory. */
export const SkillDirectorySearch = ({ query, onQueryChange, onSelect }: SkillDirectorySearchProps) => {
  const normalized = query.trim().replace(/\s+/g, " ");
  const search = useSkillDirectorySearch(normalized);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative">
        <MagnifyingGlassIcon
          aria-hidden
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-kumo-inactive"
        />
        <Input
          aria-label="Search skills.sh"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search skills.sh, e.g. cloudflare or frontend design"
          className="w-full pl-9"
          autoFocus
        />
      </div>

      {normalized.length < MIN_QUERY_LENGTH ? (
        <Text variant="secondary" size="sm">
          Find skills published on skills.sh and import them into a collection you can edit.
        </Text>
      ) : search === null ? (
        <LayerCard
          role="status"
          aria-label="Searching skills.sh"
          className="flex min-h-[160px] items-center justify-center bg-kumo-control p-1"
        >
          <Loader />
        </LayerCard>
      ) : "error" in search ? (
        <Banner
          variant="error"
          size="sm"
          icon={<WarningCircle weight="fill" />}
          title="skills.sh could not be searched"
          description={search.error}
        />
      ) : search.results.length === 0 ? (
        <LayerCard className="flex min-h-[120px] items-center justify-center bg-kumo-control p-1">
          <Text variant="secondary" size="sm">No skills on skills.sh match “{normalized}”.</Text>
        </LayerCard>
      ) : (
        <LayerCard className="overflow-hidden bg-kumo-control p-0">
          <ul aria-label="skills.sh results">
            {search.results.map((result, index) => (
              <li key={result.id} className={index > 0 ? "border-t border-kumo-line" : undefined}>
                <button
                  type="button"
                  disabled={!result.importable}
                  onClick={() => onSelect(result)}
                  className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left transition-colors enabled:hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <ScrollIcon aria-hidden size={18} className="shrink-0 text-kumo-subtle" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-kumo-default">{result.name}</span>
                    <span className="truncate text-xs text-kumo-subtle">{result.source}</span>
                  </span>
                  {result.importable ? (
                    <span className="shrink-0 text-xs tabular-nums text-kumo-subtle">
                      {formatInstalls(result.installs)}
                    </span>
                  ) : (
                    <Badge variant="neutral">Not on GitHub</Badge>
                  )}
                  <CaretRight aria-hidden size={14} className="shrink-0 text-kumo-inactive" />
                </button>
              </li>
            ))}
          </ul>
        </LayerCard>
      )}
    </div>
  );
};
