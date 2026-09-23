import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import type { SnippetCategoryItem } from './SnippetCategoryList';
import { trpc } from '~/utils/trpc';
import { useSnippetsGraph } from './useSnippetsGraph';

/**
 * Resolve the popover-ready category list for the snippets feature, reading
 * `wildcardSetIds` directly from the active `snippets` node in graph context.
 * Implements the form-mount sequence the v1 doc spec'd:
 *
 *   1. Fetch the caller's own User-kind set (always implicitly loaded).
 *   2. Fetch the union of (own-set-id ∪ ids-from-graph) via `getMany`.
 *   3. Flatten the (set, category) pairs into one item per (category, set)
 *      row — the popover groups by category internally.
 *
 * Sorted alphabetically by name, then by source name as a stable
 * tiebreaker. Ids the caller isn't authorized for are silently dropped
 * server-side (matches the inline `kind`/`ownerUserId` predicate in the
 * read service).
 *
 * Returns enough context for an Active Wildcards strip alongside the
 * categories list — `loadedSets` carries set-level metadata (name, kind,
 * audit/invalidated state, valueCount per category) so the strip can
 * render without re-querying.
 *
 * Works under either form lane (see `useSnippetsGraph`). When the active
 * subgraph has no `snippets` node, the hook treats `wildcardSetIds` as
 * empty — still safe to call unconditionally (no errors, just empty
 * results).
 */
export function useSnippetCategories() {
  // Subscribe to the snippets node so additions/removals push fresh
  // `wildcardSetIds` through without callers needing their own graph
  // plumbing. `snippets` is undefined when the node isn't in the active
  // discriminator branch — that's the v0 case where the ecosystem didn't
  // merge `snippetsGraph`.
  const { snippets, setSnippets } = useSnippetsGraph();
  // Memo on the snapshot value (stable until the node updates) so the
  // fallback empty-array branch doesn't churn a new `[]` reference per
  // render — that would re-trigger every downstream `useMemo` keyed off
  // this array.
  const wildcardSetIds = useMemo(() => snippets?.wildcardSetIds ?? [], [snippets]);

  const userSetQuery = trpc.wildcardSet.getMyUserSet.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const ownSetId = userSetQuery.data?.id;

  // The user's own User-kind set is always implicitly loaded (per the v1
  // doc) — union it with whatever the form is carrying so subsequent saves
  // immediately surface in the popover without a separate `wildcardSetIds`
  // mutation.
  const allIds = useMemo(() => {
    const set = new Set<number>(wildcardSetIds);
    if (ownSetId) set.add(ownSetId);
    return [...set];
  }, [wildcardSetIds, ownSetId]);

  // `keepPreviousData` keeps the prior response visible across query-key
  // changes (e.g. when the user adds/removes a System-kind set). Without it,
  // any add/remove flips `data` to `undefined` while the refetch runs —
  // which would (a) bail the RichTextarea orphan check and (b) blank out
  // the snippet sources strip mid-edit. With `keepPreviousData`, downstream
  // consumers see filtered stale data immediately and the strip gets a
  // per-set loading placeholder for the IDs not yet in the response.
  const setsQuery = trpc.wildcardSet.getMany.useQuery(
    { ids: allIds },
    { enabled: allIds.length > 0, refetchOnWindowFocus: false, placeholderData: keepPreviousData }
  );

  // Filter the (possibly stale) response down to IDs the user is *currently*
  // asking for. Removing a set drops its chip from the strip and its
  // categories from the popover immediately, instead of waiting for the
  // refetch to complete.
  const loadedSets = useMemo(() => {
    const data = setsQuery.data ?? [];
    const allowed = new Set(allIds);
    return data.filter((s) => allowed.has(s.id));
  }, [setsQuery.data, allIds]);

  // IDs the form is carrying that haven't appeared in a response yet —
  // either the very first fetch is in flight, or the user just added a set
  // and we're waiting on the refetch. Rendered as loading placeholders in
  // the snippet sources strip.
  //
  // Once the current query key has resolved (`isPlaceholderData === false`),
  // any allIds missing from the response were silently dropped by the
  // server (unauthorized, deleted, never existed) — not loading. The
  // effect below prunes those out of the graph's `wildcardSetIds` so this
  // hook converges to `[]` instead of leaving permanent skeleton chips.
  const loadingSetIds = useMemo(() => {
    if (setsQuery.data === undefined) return allIds;
    if (!setsQuery.isPlaceholderData) return [];
    const have = new Set(setsQuery.data.map((s) => s.id));
    return allIds.filter((id) => !have.has(id));
  }, [setsQuery.data, setsQuery.isPlaceholderData, allIds]);

  // After the current query resolves (not previous-data), drop any
  // wildcardSetIds the server didn't return. They're either unauthorized,
  // deleted, or never existed — keeping them in graph state would (a)
  // re-trigger the same dropped fetch every time `allIds` recomputes and
  // (b) leave permanent skeleton chips in the sources strip. ownSetId is
  // intentionally excluded from the prune — it's tracked separately via
  // `getMyUserSet` and isn't carried in `wildcardSetIds`.
  useEffect(() => {
    if (setsQuery.data === undefined || setsQuery.isPlaceholderData) return;
    if (wildcardSetIds.length === 0) return;
    const returned = new Set(setsQuery.data.map((s) => s.id));
    const orphans = wildcardSetIds.filter((id) => !returned.has(id));
    if (orphans.length === 0) return;
    if (!snippets) return;
    const orphanSet = new Set(orphans);
    setSnippets({
      ...snippets,
      wildcardSetIds: snippets.wildcardSetIds.filter((id) => !orphanSet.has(id)),
    });
  }, [setsQuery.data, setsQuery.isPlaceholderData, wildcardSetIds, snippets, setSnippets]);

  const categories = useMemo<SnippetCategoryItem[]>(() => {
    if (loadedSets.length === 0) return [];
    const items: SnippetCategoryItem[] = [];
    for (const set of loadedSets) {
      for (const cat of set.categories) {
        items.push({
          id: cat.name,
          label: cat.name,
          setName: set.name,
          valueCount: cat.valueCount,
        });
      }
    }
    items.sort((a, b) => {
      const byName = (a.label ?? a.id).localeCompare(b.label ?? b.id, undefined, {
        sensitivity: 'base',
      });
      if (byName !== 0) return byName;
      return (a.setName ?? '').localeCompare(b.setName ?? '');
    });
    return items;
  }, [loadedSets]);

  return {
    categories,
    loadedSets,
    loadingSetIds,
    ownSetId,
    // True only while no data has *ever* arrived for either query. After the
    // first success, refetches keep this `false` (via `keepPreviousData`),
    // so the popover never reverts to its "Loading…" empty state and the
    // orphan-detector never bails mid-edit.
    //
    // `setsQuery.isLoading` reports `true` for disabled queries that haven't
    // fetched (React Query v4 keeps status='loading' until any fetch runs).
    // Gate it behind `allIds.length > 0` so a user with zero active sets
    // doesn't get stuck in a forever-loading state — chips referencing
    // nothing should be flagged orphan immediately.
    isLoading: userSetQuery.isLoading || (allIds.length > 0 && setsQuery.isLoading),
  };
}

export type UseSnippetCategoriesResult = ReturnType<typeof useSnippetCategories>;
