import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * What this browser is waiting on. A queue that drains, not a history: every item leaves on the
 * next page load.
 *
 * ⚠️ Per-browser, and NOT the record of what a user bought — that is the orchestrator's own
 * (workflows tagged `resource-load`). This exists for the case nothing server-side knows about:
 * someone watching a load they did not pay for.
 */
export type TrackedResourceLoad = {
  modelVersionId: number;
  modelId: number;
  name: string;
  modelName: string;
  /** Epoch ms. The only thing that guarantees an item can always leave — see EXPIRY_MS. */
  requestedAt: number;
  /** `requested` paid for it; `watching` is a bystander. */
  kind: 'requested' | 'watching';
};

/**
 * 🔴 The ceiling that makes "the queue always drains" true.
 *
 * The three obvious drain rules — done, gone, still-loading — do not cover a load that FAILED or one
 * that finished and was then evicted. Both read back as `unavailable`, which is indistinguishable
 * from "queued and waiting", so without a deadline such an item is re-subscribed forever and the
 * queue is a graveyard. 48h matches the residency policy: past it, nothing is still in flight.
 */
export const RESOURCE_LOAD_EXPIRY_MS = 48 * 60 * 60 * 1000;

type ResourceLoadStore = {
  tracked: TrackedResourceLoad[];
  track: (item: Omit<TrackedResourceLoad, 'requestedAt'>) => void;
  untrack: (modelVersionId: number) => void;
  clear: () => void;
};

export const useResourceLoadStore = create<ResourceLoadStore>()(
  persist(
    (set) => ({
      tracked: [],

      track: (item) =>
        set((state) => {
          const existing = state.tracked.find((x) => x.modelVersionId === item.modelVersionId);
          // Re-tracking keeps the original timestamp: the expiry measures how long the load has been
          // outstanding, and refreshing it on every visit would let an item outlive its own deadline.
          if (existing)
            return {
              tracked: state.tracked.map((x) =>
                x.modelVersionId === item.modelVersionId
                  ? { ...x, ...item, requestedAt: x.requestedAt }
                  : x
              ),
            };
          return { tracked: [...state.tracked, { ...item, requestedAt: Date.now() }] };
        }),

      untrack: (modelVersionId) =>
        set((state) => ({
          tracked: state.tracked.filter((x) => x.modelVersionId !== modelVersionId),
        })),

      clear: () => set({ tracked: [] }),
    }),
    {
      name: 'resource-load-tracking',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    }
  )
);

export type ResourceLoadDrainVerdict =
  /** Loaded. Tell the user, then drop it. */
  | { action: 'complete' }
  /** The version is gone, or nothing is in flight for it any more. Drop it silently. */
  | { action: 'drop'; reason: 'missing' | 'not-loading' | 'expired' }
  /** Still queued or downloading. Keep it and subscribe. */
  | { action: 'keep' };

/** Decide what happens to one tracked item on page load. */
export function resourceLoadDrainVerdict(
  item: TrackedResourceLoad,
  state: { availability: { status: string; queuePosition?: number | null } } | undefined,
  now = Date.now()
): ResourceLoadDrainVerdict {
  if (!state) return { action: 'drop', reason: 'missing' };
  if (state.availability.status === 'available') return { action: 'complete' };

  // Checked BEFORE the loading cases: an expired item leaves even if the orchestrator still claims
  // it is queued, which is the failure this ceiling exists for.
  if (now - item.requestedAt > RESOURCE_LOAD_EXPIRY_MS)
    return { action: 'drop', reason: 'expired' };

  if (state.availability.status === 'loading') return { action: 'keep' };
  if (state.availability.status === 'unavailable' && state.availability.queuePosition != null)
    return { action: 'keep' };

  return { action: 'drop', reason: 'not-loading' };
}
