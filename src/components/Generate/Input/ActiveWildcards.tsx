import { Loader, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconPackage, IconPlus, IconUser, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useSnippetCategories } from './useSnippetCategories';

export type ActiveWildcardsProps = {
  /**
   * Remove a System-kind set from the form's loaded list. Called when the
   * user clicks the X on a chip. Not invoked for User-kind — the caller's
   * own set is always implicitly loaded (per v1 doc) and the chip omits
   * its remove control.
   */
  onRemoveSet?: (id: number) => void;
  /**
   * Open the picker (resource select modal) for adding a new wildcard set.
   * Caller wires this to `openResourceSelectModal(...)` filtered to
   * `Wildcards`-type models; on pick, resolve the version → set id and
   * add it to the form's `wildcardSetIds`. When omitted, the strip's
   * "Add" affordance is hidden.
   */
  onAdd?: () => void;
  /** Disable the add button while a load mutation is in-flight. */
  isAdding?: boolean;
  className?: string;
};

/**
 * Compact strip showing which wildcard sets are active for the prompt.
 * Each chip = one loaded set; per-set value count = sum of category
 * `valueCount` across non-Dirty categories the read API surfaced. Visually
 * matches the v7 "multi-source resting state" mockup — a subtle blue-tinted
 * strip with ghost-style source chips and a dashed-outline "Add set"
 * affordance. Trimmed to the v1 chrome (no per-source filter pills, no
 * "Manage sources" footer — those land with the post-v1 picker).
 *
 * The strip does double duty: it's the v1 surface for the user to *see*
 * what's loaded, and the only entry point for *removing* a System-kind
 * set without navigating back to the wildcard model page. Adding sets
 * also happens here via the inline "+ Add set" button.
 */
export function ActiveWildcards({
  onRemoveSet,
  onAdd,
  isAdding,
  className,
}: ActiveWildcardsProps) {
  // Pulls `loadedSets`/`loadingSetIds`/`ownSetId` straight from the graph
  // via `useSnippetCategories` — keeps the parent (GenerationForm) from
  // having to call the hook just to feed this strip.
  const { loadedSets, loadingSetIds, ownSetId } = useSnippetCategories();
  const containerClass = clsx(
    'flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-sm',
    'border-blue-2 bg-blue-0/60 dark:border-blue-9/30 dark:bg-blue-9/10',
    className
  );

  const pendingCount = loadingSetIds.length;
  const hasAnySets = loadedSets.length > 0 || pendingCount > 0;

  return (
    <div className={containerClass}>
      {/* Header row: label + add button on one line so the heading stays
          stable as chips wrap below. */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-6 dark:text-dark-2">Snippet sources</span>
        {onAdd ? <AddSetButton onAdd={onAdd} isAdding={isAdding} /> : null}
      </div>

      {/* Chip row(s): flex-wrap so longer set names break to additional lines
          instead of forcing horizontal scroll. */}
      {hasAnySets ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {loadedSets.map((set) => {
            const isOwn = set.id === ownSetId;
            const isUserKind = set.kind === 'User';
            const totalValues = set.categories.reduce((sum, c) => sum + c.valueCount, 0);
            const detail = `${set.categories.length} categor${
              set.categories.length === 1 ? 'y' : 'ies'
            } · ${totalValues} value${totalValues === 1 ? '' : 's'}`;
            // Removable when the caller wired a handler AND the set isn't the
            // user's always-implicit User-kind set (removing that one would
            // be a no-op since it'd auto-rejoin on the next mount).
            const removable = !!onRemoveSet && !isOwn && !isUserKind;
            const LeadIcon = set.isInvalidated
              ? IconAlertTriangle
              : isUserKind
              ? IconUser
              : IconPackage;
            return (
              <Tooltip
                key={set.id}
                label={
                  set.isInvalidated
                    ? `${set.name} — invalidated, content excluded`
                    : `${set.name} · ${detail}`
                }
                withArrow
              >
                <span
                  className={clsx(
                    'group inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs transition-colors',
                    set.isInvalidated
                      ? 'text-red-7 hover:bg-red-1 dark:text-red-4 dark:hover:bg-red-9/20'
                      : 'text-gray-7 hover:bg-blue-1 hover:text-blue-7 dark:text-dark-1 dark:hover:bg-blue-9/30 dark:hover:text-blue-3'
                  )}
                >
                  <LeadIcon size={12} className="shrink-0" />
                  <span>{set.name}</span>
                  {removable ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemoveSet?.(set.id);
                      }}
                      aria-label={`Remove ${set.name}`}
                      className={clsx(
                        'ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded transition-opacity',
                        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                        'hover:bg-blue-2 dark:hover:bg-blue-9/40'
                      )}
                    >
                      <IconX size={10} />
                    </button>
                  ) : null}
                </span>
              </Tooltip>
            );
          })}
          {loadingSetIds.map((id) => (
            <span
              key={`pending-${id}`}
              className={clsx(
                'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs',
                'text-gray-6 dark:text-dark-2'
              )}
            >
              <Loader size={10} />
              <span className="opacity-70">Loading…</span>
            </span>
          ))}
        </div>
      ) : (
        <Text size="xs" c="dimmed">
          No wildcard sets loaded — add one to use{' '}
          <Text component="span" c="bright" fw={600}>
            #
          </Text>
          -references.
        </Text>
      )}
    </div>
  );
}

function AddSetButton({ onAdd, isAdding }: { onAdd: () => void; isAdding?: boolean }) {
  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={isAdding}
      className={clsx(
        'inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-dashed px-2 text-xs transition-colors',
        'border-gray-4 text-gray-6 hover:border-gray-5 hover:text-gray-7',
        'dark:border-dark-4 dark:text-dark-2 dark:hover:border-dark-1 dark:hover:text-dark-0',
        'disabled:cursor-not-allowed disabled:opacity-60'
      )}
    >
      {isAdding ? <Loader size={10} /> : <IconPlus size={12} />}
      Add set
    </button>
  );
}
