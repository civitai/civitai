import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { EngagedModelType } from '~/store/engaged-models.store';
import { getEngagedStoreGeneration, useEngagedModelsStore } from '~/store/engaged-models.store';
import {
  excludeFromEngagedPersistence,
  initEngagedModelsPersistence,
} from '~/store/engaged-models.persist';
import { trpcVanilla } from '~/utils/trpc';
import { scheduleBatcherFlush } from '~/utils/trpc-batch-window';

/**
 * Batched dataloader for engagement membership (PR2). Components register the
 * model ids currently on screen; a module-level batcher coalesces every id
 * requested within a short debounce WINDOW, drops the ones already known to the
 * store, chunks the remainder to the endpoint's ≤200 cap, and issues ONE
 * `user.getEngagedModelsByIds` query per chunk — folding the result back into
 * the store. Classic DataLoader-in-React.
 *
 * The window is anchored at the FIRST pending id and does NOT reset on later
 * ids (the `scheduled` flag blocks re-scheduling until `flush` runs), so under
 * continuous scrolling the batcher still flushes every ~80ms — bounded latency,
 * no starvation. Widening from the original single-microtask coalesce to ~80ms
 * folds ids that arrive across many render ticks / scroll frames into a single
 * request, cutting the number of `user.getEngagedModelsByIds` calls (and the
 * fixed per-request middleware CPU each one carries).
 *
 * Reads come straight off the reactive store (`useIsEngaged` etc.), so an
 * optimistic mutation is reflected instantly without any refetch.
 */

const MAX_IDS_PER_QUERY = 200; // must match getEngagedModelsByIdsSchema.max(200)

/**
 * Client-side coalescing window for the engaged-membership batcher. Tunable.
 * Trade-off: up to this many ms of extra latency before a model's membership
 * (favorite-heart / notify-bell state) hydrates, in exchange for far fewer
 * network calls. 80ms sits below the ~100ms "instant" perception threshold, so
 * the heart/bell hydration is not perceptibly laggy, while being wide enough to
 * absorb a burst of card mounts across several render ticks into one request.
 */
export const ENGAGED_MEMBERSHIP_DEBOUNCE_MS = 80;

/** How long a failed request waits before its single retry. */
export const ENGAGED_MEMBERSHIP_RETRY_MS = 3000;

// Module-level batcher state.
const pending = new Set<number>();
const inFlight = new Set<number>();
let scheduled = false;
/** The store generation `pending`/`inFlight` belong to; a store reset (sign-out) orphans both. */
let stateGeneration = getEngagedStoreGeneration();

function dropStateFromAnEarlierGeneration() {
  const current = getEngagedStoreGeneration();
  if (current === stateGeneration) return;
  stateGeneration = current;
  pending.clear();
  inFlight.clear();
}

/**
 * Test/injection seam. Production uses the vanilla tRPC client + an ~80ms
 * debounce flush (which, while `trpcUnifiedBatchWindow` applies, then waits for the
 * shared batch window to close); tests swap in a controllable fetcher and a synchronous
 * scheduler. `schedule` returns void so a test override may return void too.
 */
export const engagedMembershipBatcher = {
  fetch: (modelIds: number[]) => trpcVanilla.user.getEngagedModelsByIds.query({ modelIds }),
  schedule: (cb: () => void): void => {
    scheduleBatcherFlush(cb, ENGAGED_MEMBERSHIP_DEBOUNCE_MS);
  },
  scheduleRetry: (cb: () => void): void => {
    setTimeout(cb, ENGAGED_MEMBERSHIP_RETRY_MS);
  },
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function flush() {
  scheduled = false;
  dropStateFromAnEarlierGeneration();
  const { queried } = useEngagedModelsStore.getState();

  const toFetch: number[] = [];
  for (const id of pending) {
    if (!queried.has(id) && !inFlight.has(id)) toFetch.push(id);
  }
  pending.clear();
  if (toFetch.length === 0) return;

  for (const id of toFetch) inFlight.add(id);
  for (const ids of chunk(toFetch, MAX_IDS_PER_QUERY))
    fetchChunk(ids, getEngagedStoreGeneration(), true);
}

/**
 * One request for `ids`, answered into the store only if the store has not been reset since it
 * was sent (`generation`) — a sign-out mid-request must not hand the old viewer's answer to the
 * signed-out store. The ids stay in flight through the retry, so a card mounting meanwhile does
 * not ask again.
 */
function fetchChunk(ids: number[], generation: number, retryOnError: boolean) {
  const current = () => generation === getEngagedStoreGeneration();
  const settle = () => {
    if (current()) for (const id of ids) inFlight.delete(id);
  };
  engagedMembershipBatcher.fetch(ids).then(
    (record) => {
      if (current()) useEngagedModelsStore.getState().applyServerResult(record ?? {}, ids);
      settle();
    },
    () => {
      if (!current()) return;
      if (retryOnError) {
        // A page of cards shares one request, so a single blip would otherwise read as "not
        // engaged" for every model on it, and on any model page opened from it, for the session.
        engagedMembershipBatcher.scheduleRetry(() => {
          if (!current()) return;
          const { queried } = useEngagedModelsStore.getState();
          const stillUnknown = ids.filter((id) => !queried.has(id));
          for (const id of ids) if (queried.has(id)) inFlight.delete(id);
          if (stillUnknown.length) fetchChunk(stillUnknown, generation, false);
        });
        return;
      }
      // F2 (stuck-disabled): the retry failed too. Left unknown, a mounted control (its effect
      // never re-fires) would stay `disabled = !isKnown` for good, so mark the ids
      // known-not-engaged — in memory only, so the next load asks again. The dirty-guard still
      // protects ids the user mutated meanwhile. Accepted: a genuinely-ON model reads off until
      // reload or the user's next interaction; a usable button beats a dead one.
      excludeFromEngagedPersistence(ids);
      useEngagedModelsStore.getState().applyServerResult({}, ids);
      settle();
    }
  );
}

/**
 * Register model ids for membership lookup. Ids already known to the store, or
 * already pending/in-flight, are skipped (dedup). Non-positive ids are ignored.
 */
export function requestEngagedMembership(modelIds: Iterable<number>): void {
  dropStateFromAnEarlierGeneration();
  const { queried } = useEngagedModelsStore.getState();
  let added = false;
  for (const id of modelIds) {
    if (!(id > 0)) continue;
    if (queried.has(id) || inFlight.has(id) || pending.has(id)) continue;
    pending.add(id);
    added = true;
  }
  if (added && !scheduled) {
    scheduled = true;
    engagedMembershipBatcher.schedule(flush);
  }
}

/** Test helper: clear the module-level batcher state between tests. */
export function __resetEngagedMembershipBatcher(): void {
  pending.clear();
  inFlight.clear();
  scheduled = false;
  stateGeneration = getEngagedStoreGeneration();
}

export interface EngagedMembershipResult {
  /** Reactive membership check for one of the registered ids. */
  isEngaged: (modelId: number, type: EngagedModelType) => boolean;
  /** All engagement types for one of the registered ids. */
  getTypes: (modelId: number) => EngagedModelType[];
  /** Reactive per-id type-sets, aligned to the passed `modelIds` order. */
  sets: (ReadonlySet<EngagedModelType> | undefined)[];
  /** True while any requested id is still unknown (query in flight / pending). */
  isLoading: boolean;
  /**
   * Per-id "do we have definitive knowledge of this model's membership yet?".
   * True once the id is in the store's `queried` set — i.e. a server result has
   * landed OR an optimistic write has set it. Controls that compute a toggle
   * direction from membership MUST gate their action on this (F1): while a model
   * is unknown the store reads as not-engaged, so an un-gated toggle would fire
   * the OPPOSITE of the user's intent. Ids ≤ 0 are never known.
   *
   * ALWAYS true when there is no authenticated user: an unauth user has no
   * membership to toggle wrongly (the endpoint is protected, so nothing is ever
   * queried and the id would otherwise stay "unknown" forever). Controls gate
   * `disabled = loading = !isKnown`, so a perpetually-false isKnown would leave
   * a logged-out user's control permanently disabled — and a disabled element
   * can't fire the LoginRedirect click that prompts sign-in. Returning true for
   * unauth keeps the control interactive so that click reaches LoginRedirect.
   */
  isKnown: (modelId: number) => boolean;
}

/** Shared by the per-card read and the surface-wide prefetch, so both gate and rehydrate alike. */
function useRegisterEngagedMembership(modelIds: number[]) {
  const currentUser = useCurrentUser();
  const validIds = modelIds.filter((id) => id > 0);
  const enabled = !!currentUser && validIds.length > 0;
  const key = validIds.join(',');

  // Rehydrate the membership store from localStorage for the current user (and
  // wire write-back) so a returning/reloading tab doesn't re-query ids it already
  // knows-and-fresh. Client-only (effects don't run in SSR), keyed on the user id
  // so a user change re-keys the persisted blob. Idempotent — the persistence
  // module early-returns when the user is unchanged. No-op when storage is
  // unavailable, leaving the store memory-only (today's behavior).
  const currentUserId = currentUser?.id ?? null;
  useEffect(() => {
    initEngagedModelsPersistence(currentUserId);
  }, [currentUserId]);

  useEffect(() => {
    if (!enabled) return;
    requestEngagedMembership(validIds);
    // key encodes validIds; enabled gates on auth. Intentionally not depending
    // on the array identity (new each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return { currentUser, validIds, enabled };
}

/**
 * Register a whole surface's ids from the container that holds them (a feed page, a page
 * of search hits). A card renders its body only near the viewport, so cards alone register
 * a row at a time while the user scrolls and each row lands in its own batch window — one
 * request per row instead of one per page. Reads nothing; the cards still read their own.
 */
export function useEngagedModelsPrefetch(modelIds: number[]): void {
  useRegisterEngagedMembership(modelIds);
}

/**
 * Register `modelIds` (only those the caller currently has on screen) and read
 * their membership reactively from the store. Unauthenticated users issue no
 * query and see empty membership (the endpoint is protected).
 */
export function useEngagedModelsMembership(modelIds: number[]): EngagedMembershipResult {
  const { currentUser, validIds, enabled } = useRegisterEngagedMembership(modelIds);

  const sets = useEngagedModelsStore(useShallow((s) => modelIds.map((id) => s.membership[id])));
  const knownFlags = useEngagedModelsStore(
    useShallow((s) => validIds.map((id) => s.queried.has(id)))
  );

  const byId = new Map<number, ReadonlySet<EngagedModelType> | undefined>();
  modelIds.forEach((id, i) => byId.set(id, sets[i]));

  const knownById = new Map<number, boolean>();
  validIds.forEach((id, i) => knownById.set(id, knownFlags[i]));

  // F1 (unauth): with no user there is nothing to query and nothing to toggle
  // wrongly — treat every id as known so gated controls stay interactive and a
  // logged-out click can reach LoginRedirect. (`enabled` is already false here,
  // so `isLoading` is false too.)
  const noUser = !currentUser;

  return {
    isEngaged: (modelId, type) => byId.get(modelId)?.has(type) ?? false,
    getTypes: (modelId) => [...(byId.get(modelId) ?? [])],
    sets,
    isLoading: enabled && knownFlags.some((known) => !known),
    isKnown: (modelId) => noUser || (knownById.get(modelId) ?? false),
  };
}

/** Single-model convenience wrapper. */
export function useEngagedModelMembership(modelId: number) {
  const { isEngaged, getTypes, isLoading, isKnown } = useEngagedModelsMembership([modelId]);
  return {
    isEngaged: (type: EngagedModelType) => isEngaged(modelId, type),
    types: getTypes(modelId),
    isLoading,
    /** Definitive membership knowledge for this model (see EngagedMembershipResult.isKnown). */
    isKnown: isKnown(modelId),
  };
}
