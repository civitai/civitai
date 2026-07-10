import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { EngagedModelType } from '~/store/engaged-models.store';
import { useEngagedModelsStore } from '~/store/engaged-models.store';
import { trpcVanilla } from '~/utils/trpc';

/**
 * Batched dataloader for engagement membership (PR2). Components register the
 * model ids currently on screen; a module-level batcher coalesces every id
 * requested within one microtask, drops the ones already known to the store,
 * chunks the remainder to the endpoint's ≤200 cap, and issues ONE
 * `user.getEngagedModelsByIds` query per chunk — folding the result back into
 * the store. Classic DataLoader-in-React.
 *
 * Reads come straight off the reactive store (`useIsEngaged` etc.), so an
 * optimistic mutation is reflected instantly without any refetch.
 */

const MAX_IDS_PER_QUERY = 200; // must match getEngagedModelsByIdsSchema.max(200)

// Module-level batcher state.
const pending = new Set<number>();
const inFlight = new Set<number>();
let scheduled = false;

/**
 * Test/injection seam. Production uses the vanilla tRPC client + a microtask
 * flush; tests swap in a controllable fetcher and a synchronous scheduler.
 */
export const engagedMembershipBatcher = {
  fetch: (modelIds: number[]) => trpcVanilla.user.getEngagedModelsByIds.query({ modelIds }),
  schedule: (cb: () => void) => queueMicrotask(cb),
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function flush() {
  scheduled = false;
  const { queried } = useEngagedModelsStore.getState();

  const toFetch: number[] = [];
  for (const id of pending) {
    if (!queried.has(id) && !inFlight.has(id)) toFetch.push(id);
  }
  pending.clear();
  if (toFetch.length === 0) return;

  for (const id of toFetch) inFlight.add(id);

  for (const ids of chunk(toFetch, MAX_IDS_PER_QUERY)) {
    engagedMembershipBatcher
      .fetch(ids)
      .then(
        (record) => {
          // Re-read applyServerResult off the live store in case the store was reset.
          useEngagedModelsStore.getState().applyServerResult(record ?? {}, ids);
        },
        () => {
          // F2 (stuck-disabled): the fetch errored. If we left these ids unknown a
          // component that stays mounted (unchanged deps → its effect never re-fires)
          // would never re-request them, leaving its `disabled = loading = !isKnown`
          // control PERMANENTLY dead with no retry. Mark them known-not-engaged so the
          // control becomes actionable again. The dirty-guard still protects any id the
          // user mutated meanwhile (locallyMutated is skipped). Trade-off, accepted: in
          // this rare error case the F1 wrong-direction risk returns for a genuinely-ON
          // model (it reads not-engaged) — a usable button beats a dead one, and the
          // optimistic dual-write self-heals the store on the user's next interaction.
          useEngagedModelsStore.getState().applyServerResult({}, ids);
        }
      )
      .finally(() => {
        for (const id of ids) inFlight.delete(id);
      });
  }
}

/**
 * Register model ids for membership lookup. Ids already known to the store, or
 * already pending/in-flight, are skipped (dedup). Non-positive ids are ignored.
 */
export function requestEngagedMembership(modelIds: Iterable<number>): void {
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

/**
 * Register `modelIds` (only those the caller currently has on screen) and read
 * their membership reactively from the store. Unauthenticated users issue no
 * query and see empty membership (the endpoint is protected).
 */
export function useEngagedModelsMembership(modelIds: number[]): EngagedMembershipResult {
  const currentUser = useCurrentUser();
  const validIds = modelIds.filter((id) => id > 0);
  const enabled = !!currentUser && validIds.length > 0;
  const key = validIds.join(',');

  useEffect(() => {
    if (!enabled) return;
    requestEngagedMembership(validIds);
    // key encodes validIds; enabled gates on auth. Intentionally not depending
    // on the array identity (new each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  const sets = useEngagedModelsStore(
    useShallow((s) => modelIds.map((id) => s.membership[id]))
  );
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
