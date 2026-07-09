import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { ModelEngagementType } from '~/shared/utils/prisma/enums';

/**
 * Client-side normalized engagement-membership store (PR2 of the
 * `user.getEngagedModels` freeze-fix).
 *
 * The legacy `user.getEngagedModels` endpoint returned a user's ENTIRE
 * engagement history (a whale's ~450k ids → 3.75 MB synchronous serialize →
 * froze an api-primary pod). PR1 (#3028) added the bounded
 * `user.getEngagedModelsByIds({ modelIds ≤200 })` endpoint. This store holds the
 * per-model membership so a caller only ever asks the server about the models
 * currently ON SCREEN — bounding the payload by visible-set size, not account
 * size.
 *
 * Two pieces of state, so we can distinguish three cases per model id:
 *   - `membership[id]` present, non-empty  → engaged (has these types)
 *   - `membership[id]` present, empty set  → queried, NOT engaged (known)
 *   - `id` absent from `queried`            → unknown / not yet queried
 *
 * `queried` is the source of truth for "known". `membership[id]` holds the types.
 */

export type EngagedModelType = ModelEngagementType | 'Recommended';

/** The bounded endpoint's response shape (a subset of the queried ids per type). */
export type EngagedModelsByIdsResult = Partial<Record<EngagedModelType, number[]>>;

interface EngagedModelsState {
  /** modelId → set of engagement types (only for ids that have been observed). */
  membership: Record<number, ReadonlySet<EngagedModelType>>;
  /** modelIds we have definitive knowledge about (queried or optimistically written). */
  queried: ReadonlySet<number>;

  /** Toggle a single (modelId, type) on/off. Marks the id as known. */
  setMembership: (modelId: number, type: EngagedModelType, on: boolean) => void;
  /** Replace the full type-set for a model (used by rollback). Marks the id known. */
  replaceMembership: (modelId: number, types: Iterable<EngagedModelType>) => void;
  /**
   * Fold a server result into the store. `record` is the per-type id lists from
   * the endpoint; `queriedIds` are ALL ids that were asked about — every one of
   * them is marked known even when absent from `record` (→ known-not-engaged).
   */
  applyServerResult: (record: EngagedModelsByIdsResult, queriedIds: number[]) => void;
  /** Clear everything (tests / sign-out). */
  reset: () => void;
}

function setsEqual(a: ReadonlySet<EngagedModelType> | undefined, b: ReadonlySet<EngagedModelType>) {
  if (!a || a.size !== b.size) return false;
  for (const v of b) if (!a.has(v)) return false;
  return true;
}

export const useEngagedModelsStore = create<EngagedModelsState>((set) => ({
  membership: {},
  queried: new Set<number>(),

  setMembership: (modelId, type, on) =>
    set((state) => {
      const prev = state.membership[modelId];
      const next = new Set<EngagedModelType>(prev ?? []);
      if (on) next.add(type);
      else next.delete(type);

      const alreadyKnown = state.queried.has(modelId);
      // Nothing changed and the id was already known — keep refs stable so we
      // don't fan a selector run out to every consumer.
      if (alreadyKnown && setsEqual(prev, next)) return state;

      const queried = alreadyKnown ? state.queried : new Set(state.queried).add(modelId);
      return { membership: { ...state.membership, [modelId]: next }, queried };
    }),

  replaceMembership: (modelId, types) =>
    set((state) => {
      const next = new Set<EngagedModelType>(types);
      const alreadyKnown = state.queried.has(modelId);
      if (alreadyKnown && setsEqual(state.membership[modelId], next)) return state;
      const queried = alreadyKnown ? state.queried : new Set(state.queried).add(modelId);
      return { membership: { ...state.membership, [modelId]: next }, queried };
    }),

  applyServerResult: (record, queriedIds) =>
    set((state) => {
      // Start every queried id at an empty set → any id absent from `record`
      // becomes known-not-engaged (distinct from unknown).
      const byId = new Map<number, Set<EngagedModelType>>();
      for (const id of queriedIds) byId.set(id, new Set());

      for (const [type, ids] of Object.entries(record) as [EngagedModelType, number[] | undefined][]) {
        if (!ids) continue;
        for (const id of ids) {
          let s = byId.get(id);
          if (!s) {
            // Defensive: server returned an id we didn't ask about — still record it.
            s = new Set();
            byId.set(id, s);
          }
          s.add(type);
        }
      }

      const membership = { ...state.membership };
      const queried = new Set(state.queried);
      for (const [id, s] of byId) {
        membership[id] = s;
        queried.add(id);
      }
      return { membership, queried };
    }),

  reset: () => set({ membership: {}, queried: new Set<number>() }),
}));

// ---------------------------------------------------------------------------
// Non-reactive reads (for imperative call sites: optimistic handlers, batcher).
// ---------------------------------------------------------------------------

export function isModelEngaged(modelId: number, type: EngagedModelType): boolean {
  return useEngagedModelsStore.getState().membership[modelId]?.has(type) ?? false;
}

export function isModelQueried(modelId: number): boolean {
  return useEngagedModelsStore.getState().queried.has(modelId);
}

export function getEngagedModelTypes(modelId: number): EngagedModelType[] {
  return [...(useEngagedModelsStore.getState().membership[modelId] ?? [])];
}

/** Snapshot the current type-set for a model (a detached clone for rollback). */
export function snapshotMembership(modelId: number): Set<EngagedModelType> {
  return new Set(useEngagedModelsStore.getState().membership[modelId] ?? []);
}

/** Restore a previously-snapshotted type-set (rollback). */
export function restoreMembership(modelId: number, snapshot: Iterable<EngagedModelType>): void {
  useEngagedModelsStore.getState().replaceMembership(modelId, snapshot);
}

// ---------------------------------------------------------------------------
// Reactive selector hooks.
// ---------------------------------------------------------------------------

export function useIsEngaged(modelId: number, type: EngagedModelType): boolean {
  return useEngagedModelsStore((s) => s.membership[modelId]?.has(type) ?? false);
}

export function useEngagedTypes(modelId: number): EngagedModelType[] {
  return useEngagedModelsStore(useShallow((s) => [...(s.membership[modelId] ?? [])]));
}
