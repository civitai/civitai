/**
 * Generation Graph Store
 *
 * Store for passing generation data to the DataGraph-based form.
 * Handles opening the generation sidebar, fetching generation data,
 * and providing graph-compatible data to GenerationFormProvider.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { GetGenerationDataInput } from '~/server/schema/generation.schema';
import type { GenerationData } from '~/server/services/generation/generation.service';
import type { GenerationResource } from '~/shared/types/generation.types';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { remixStore } from '~/store/remix.store';
import { trpcVanilla } from '~/utils/trpc';

// =============================================================================
// Constants
// =============================================================================

/** Enhancement workflows that should fall back to txt2img when remixing */
export const REMIX_WORKFLOW_OVERRIDES: Record<string, string> = {
  'txt2img:hires-fix': 'txt2img',
  'img2img:hires-fix': 'txt2img',
  'txt2img:face-fix': 'txt2img',
  'img2img:face-fix': 'txt2img',
};

// =============================================================================
// Types
// =============================================================================

export type RunType = 'run' | 'remix' | 'replay' | 'patch' | 'append' | 'wildcard';

/**
 * Open the panel directly to add a wildcard set to the snippets node. No
 * network fetch — the caller (typically the Generate button on a Wildcards
 * model page) already has the `wildcardSetId` from `model.getById`'s
 * response, so a round-trip would just re-derive what we already know.
 *
 * The form provider's `wildcard` runType branch merges this id into the
 * existing snippets node, preserving the user's mode/batchCount/targets/seed.
 */
export type GenerationGraphOpenInput =
  | GetGenerationDataInput
  | { type: 'wildcard'; wildcardSetId: number };

/**
 * Graph-compatible generation data.
 * Params should already be in graph format (workflow, baseModel, aspectRatio as object, etc.)
 */
export interface GenerationGraphData {
  /** Params from step.metadata.params or fetched generation data */
  params: Record<string, unknown>;
  /** Resources in full GenerationResource format */
  resources: GenerationResource[];
  /** Type of run (determines reset behavior in form provider) */
  runType: RunType;
  /** Optional remix reference */
  remixOfId?: number;
}

/**
 * High-level discriminator describing how the panel was last opened.
 *
 * - 'create'  — opened from a model / modelVersion (Create button, model card)
 * - 'remix'   — opened from a media item (image / video / audio remix click)
 * - 'replay'  — re-run from the queue or a previous output
 * - 'direct'  — opened with no input (panel default, /generate page, etc.)
 *
 * Tracked on the store so submit-time telemetry (Generator_Submit) can
 * attribute submissions back to their entry-point click event. `data.runType`
 * is cleared by the form provider on consumption, so we keep this lighter
 * marker around until the next open / submit.
 */
export type GeneratorEntryAction = 'create' | 'remix' | 'replay' | 'direct';

interface GenerationGraphState {
  /** Counter for change detection (increments on each setData) */
  counter: number;
  /** Whether generation data is being fetched */
  loading: boolean;
  /** Pending data to apply to the form */
  data?: GenerationGraphData;
  /** Funnel-telemetry discriminator — see GeneratorEntryAction */
  lastEntryAction: GeneratorEntryAction;
  /**
   * Monotonic open-sequence counter.
   *
   * Incremented synchronously at the start of every `open()` call (including
   * the wildcard and no-input branches). Async input branches capture the
   * sequence before awaiting the fetch and re-check it on resolve — if a
   * later `open()` has bumped the sequence in the meantime, the older fetch
   * aborts its state mutation instead of clobbering attribution.
   *
   * Protects against the concurrent-open race:
   *   t0: user clicks Remix         → open({media}) → seq=1, fetch starts
   *   t1: user clicks navbar Create → open()         → seq=2 sync, lastEntryAction='direct'
   *   t2: t0 fetch resolves         → seq still 2 ≠ captured 1 → abort
   *
   * Without this guard, t2 would set lastEntryAction='remix' and clobber the
   * navbar's 'direct' attribution that's already been observed by any submit
   * happening between t1 and t2.
   */
  openSequence: number;
  /**
   * Open the generation sidebar, optionally fetching data for a model/image.
   *
   * `options.preserveEntryAction = true` skips the `lastEntryAction` write,
   * which is important for mid-session re-entries (e.g. swapping the base
   * model from inside the generator). Without it, an in-panel
   * `open({type:'modelVersion', ...})` overwrites the upstream entry-action
   * (e.g. 'remix') with 'create', so the eventual Generator_Submit attributes
   * to the wrong funnel branch. The mirror carve-out exists in `setData` for
   * the `patch`/`append` runTypes; this is its open()-side analog.
   */
  open: (
    input?: GenerationGraphOpenInput,
    options?: { preserveEntryAction?: boolean }
  ) => Promise<void>;
  /** Close the generation sidebar */
  close: () => void;
  /** Set generation data for the form to consume */
  setData: (data: Omit<GenerationGraphData, 'runType'> & { runType?: RunType }) => void;
  /** Clear pending data (called by form provider after consuming) */
  clearData: () => void;
}

/**
 * Map the internal store RunType onto the public funnel-telemetry shape.
 *
 * NOTE: callers MUST NOT invoke this with `runType === 'patch' | 'append'`.
 * Those are mid-session sub-flows that need to *preserve* the previous
 * entry-action, not overwrite it — `setData` short-circuits before calling
 * this for patch/append. They are kept on the `RunType` union because they
 * are still meaningful to the form provider's runType branch.
 */
function toEntryAction(runType: RunType): GeneratorEntryAction {
  switch (runType) {
    case 'remix':
      return 'remix';
    case 'replay':
      return 'replay';
    case 'run':
    case 'wildcard':
      return 'create';
    default:
      return 'direct';
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** Apply resource substitutions (use substitute if original can't generate) */
function substituteResource(item: GenerationResource): GenerationResource {
  const { substitute, ...rest } = item;
  if (!rest.canGenerate && substitute?.canGenerate) return { ...item, ...substitute };
  return rest;
}

/** Build a normalized cache key for a generation data request.
 *
 * `modelVersion` (single ID) and `modelVersions` ([single ID]) share the same
 * key so parallel or sequential calls for the same model version are deduplicated.
 * Multi-ID `modelVersions` requests use a sorted key to be order-independent.
 */
function buildGenerationDataKey(input: GetGenerationDataInput): string {
  switch (input.type) {
    case 'modelVersion':
      return `model_${input.id}${input.epoch ? `_e${input.epoch}` : ''}`;
    case 'modelVersions': {
      const ids = (Array.isArray(input.ids) ? input.ids : [input.ids])
        .slice()
        .sort((a, b) => a - b);
      return `model_${ids.join('_')}`;
    }
    default:
      return `media_${input.id}`;
  }
}

/**
 * In-flight + resolved promise cache.
 * Caching the Promise (not just the resolved value) deduplicates parallel
 * calls with the same key — the second caller awaits the same in-flight request.
 */
const generationDataCache = new Map<string, Promise<GenerationData>>();

/**
 * Module-level counter of input-bearing `open()` calls currently awaiting a
 * `fetchGenerationData` resolution. Read by the sequence-mismatch bail-out
 * paths to decide whether resetting `loading = false` would stomp a newer
 * fetch that is still pending. See `loading` field invariant in the store.
 *
 * NOTE: this is intentionally module-scoped (not store state) — it's an
 * implementation detail of the concurrent-open race guard and has no
 * meaning to subscribers.
 */
let inFlightFetchCount = 0;

export function fetchGenerationData(input: GetGenerationDataInput): Promise<GenerationData> {
  const key = buildGenerationDataKey(input);

  const cached = generationDataCache.get(key);
  if (cached) return cached;

  const promise = trpcVanilla.generation.getGenerationData
    .query({ ...input, withPreview: true })
    .then((data) => data as GenerationData)
    .catch((err) => {
      generationDataCache.delete(key); // Allow retry on failure
      throw err;
    });

  generationDataCache.set(key, promise);
  return promise;
}

// =============================================================================
// Store
// =============================================================================

export const useGenerationGraphStore = create<GenerationGraphState>()(
  devtools(
    immer((set, get) => ({
      counter: 0,
      loading: false,
      data: undefined,
      lastEntryAction: 'direct' as GeneratorEntryAction,
      openSequence: 0,

      open: async (input, options) => {
        const preserveEntryAction = options?.preserveEntryAction === true;
        // Increment sequence synchronously so any subsequent open() — even
        // one that runs before this function's first await — supersedes us.
        // Capture the local for use after the await to detect superseding.
        let capturedSequence = 0;
        set((state) => {
          state.openSequence++;
          capturedSequence = state.openSequence;
        });

        useGenerationPanelStore.setState({ opened: true });
        if (input) {
          useGenerationPanelStore.setState({ view: 'generate' });

          // Wildcard entry point: no fetch required, just hand the
          // wildcardSetId to the form provider's `wildcard` runType branch
          // which merges it into the snippets node. Synchronous, so no
          // sequence re-check needed — but we still bumped the counter above
          // to invalidate any in-flight media/model fetches.
          if (input.type === 'wildcard') {
            set((state) => {
              state.data = {
                params: { wildcardSetId: input.wildcardSetId },
                resources: [],
                runType: 'wildcard',
              };
              if (!preserveEntryAction) state.lastEntryAction = 'create';
              // Wildcard is synchronous — clear loading so a superseded
              // input-bearing open() that set loading=true earlier doesn't
              // leave consumers stuck on a spinner.
              state.loading = false;
              state.counter++;
            });
            return;
          }

          set((state) => {
            state.loading = true;
          });
          inFlightFetchCount++;

          try {
            const result = await fetchGenerationData(input);

            // Concurrent-open race guard. If another open() has run while
            // we awaited, our captured sequence won't match the live one —
            // bail without clobbering the newer open's attribution / data.
            // See `openSequence` JSDoc above.
            //
            // Loading-flag invariant: only the latest open() owns `loading`.
            // If we were the only in-flight fetch (count drops to 0 after
            // we decrement) and `loading` is still true, the newer open()
            // was synchronous (no-input / wildcard) and didn't touch it —
            // we must clear it ourselves or consumers stay stuck on a
            // spinner. If other fetches are still pending, leave `loading`
            // alone — they'll resolve it on their own success path.
            if (get().openSequence !== capturedSequence) {
              inFlightFetchCount--;
              if (inFlightFetchCount === 0 && get().loading) {
                set((state) => {
                  state.loading = false;
                });
              }
              return;
            }

            const isMedia = ['audio', 'image', 'video'].includes(input.type);
            const resources = result.resources.map(substituteResource);

            // When remixing enhancement workflows (hires-fix, face-fix), fall back to
            // txt2img so the user gets a standard generation form.
            if (isMedia) {
              const w = result.params.workflow as string | undefined;
              if (w && REMIX_WORKFLOW_OVERRIDES[w]) {
                result.params.workflow = REMIX_WORKFLOW_OVERRIDES[w];
              }
            }

            // Update remix store for similarity tracking
            if (isMedia && result.remixOfId) {
              remixStore.setRemix(result.remixOfId, result.params);
            }

            set((state) => {
              state.data = {
                params: result.params,
                resources,
                runType: isMedia ? 'remix' : 'run',
                remixOfId: result.remixOfId,
              };
              if (!preserveEntryAction) {
                state.lastEntryAction = isMedia ? 'remix' : 'create';
              }
              state.loading = false;
              state.counter++;
            });
            inFlightFetchCount--;
          } catch (e) {
            // If a newer open() has already taken over, swallow the error
            // — we're not the active open anymore and have no right to
            // mutate lastEntryAction on its behalf. Loading-flag invariant
            // mirrors the resolve path: only clear `loading` when we were
            // the last in-flight fetch.
            if (get().openSequence !== capturedSequence) {
              inFlightFetchCount--;
              if (inFlightFetchCount === 0 && get().loading) {
                set((state) => {
                  state.loading = false;
                });
              }
              return;
            }
            // Reset attribution on fetch failure so the next submit can't
            // accidentally inherit a stale entry-action from this aborted
            // open (e.g. user clicked Remix, fetch failed, user opens panel
            // again with no input — should be 'direct', not 'remix').
            //
            // When `preserveEntryAction` is set, the caller is a mid-session
            // re-entry that explicitly opted out of attribution writes — a
            // failed in-panel base-model swap should NOT scrub the upstream
            // entry-action from the funnel.
            set((state) => {
              state.loading = false;
              if (!preserveEntryAction) state.lastEntryAction = 'direct';
            });
            inFlightFetchCount--;
            throw e;
          }
        } else {
          // No input — user opened the panel directly (e.g. from /generate
          // or the sidebar toggle). Preserve the previous entry-action when
          // the panel is being re-opened mid-session; only reset to 'direct'
          // if there's no in-flight data to attribute against. The
          // synchronous openSequence++ above ensures any concurrent
          // input-bearing open() that resolves AFTER us will see its
          // captured sequence != live and abort, so this branch's
          // attribution wins.
          //
          // Clear `loading` unconditionally: this branch is synchronous, so
          // there's nothing to wait on. A superseded input-bearing open()
          // that set loading=true would otherwise leave consumers stuck on
          // a spinner (the bail-out path leaves `loading` alone when other
          // fetches are still in flight — but here, there's no "us" to
          // own loading, so claim the false-write for the latest open).
          set((state) => {
            if (!state.data && !preserveEntryAction) state.lastEntryAction = 'direct';
            state.loading = false;
          });
        }
      },

      close: () => {
        // Reset attribution at session-end so a stale entry-action can't leak
        // into the next open. Submit happens BEFORE close in the happy path,
        // so this is safe; opens without input then correctly resolve to
        // 'direct' (the no-input branch in `open` preserves an in-flight
        // action only when `state.data` is still set).
        set((state) => {
          state.lastEntryAction = 'direct';
        });
        useGenerationPanelStore.setState({ opened: false });
      },

      setData: ({ params, resources, runType = 'replay', remixOfId }) => {
        if (typeof window !== 'undefined' && !location.pathname.startsWith('/generate'))
          useGenerationPanelStore.setState({ view: 'generate' });

        // Update remix store for similarity tracking
        if ((runType === 'remix' || runType === 'replay') && remixOfId) {
          remixStore.setRemix(remixOfId, params);
        }

        set((state) => {
          state.data = {
            params,
            resources,
            runType,
            remixOfId,
          };
          // Patch/append are sub-flows inside an already-open session
          // (apply-workflow-to-result, append-to-upscale-batch, etc.).
          // They MUST preserve the previous entry-action so the eventual
          // Generator_Submit can still attribute back to the original
          // create/remix/replay click. Only intentful entry-points
          // (run/remix/replay/wildcard) overwrite lastEntryAction.
          if (runType !== 'patch' && runType !== 'append') {
            state.lastEntryAction = toEntryAction(runType);
          }
          state.counter++;
        });
      },

      clearData: () => {
        // NOTE: do NOT reset lastEntryAction here. All three form providers
        // call clearData() immediately after consuming the pending data —
        // which happens at open-time, long BEFORE the user clicks Generate.
        // Resetting here destroyed the create/remix/replay attribution that
        // Generator_Submit depends on. Reset lives in `close()` (session end)
        // and on fetch-failure in `open()` instead.
        set((state) => {
          state.data = undefined;
        });
      },
    })),
    { name: 'generation-graph-store' }
  )
);

// =============================================================================
// Convenience API
// =============================================================================

const store = useGenerationGraphStore.getState();

export const generationGraphPanel = {
  open: store.open,
  close: store.close,
  setView: (view: 'generate' | 'queue' | 'feed') => useGenerationPanelStore.setState({ view }),
  /** Save the current panel view so it can be restored after an enhancement workflow */
  setViewWithReturn: (view: 'generate' | 'queue' | 'feed') => {
    const { view: currentView } = useGenerationPanelStore.getState();
    useGenerationPanelStore.setState({ view, previousView: currentView });
  },
  /** Restore the previously saved panel view (clears previousView) */
  restorePreviousView: () => {
    const { previousView } = useGenerationPanelStore.getState();
    if (previousView) {
      useGenerationPanelStore.setState({ view: previousView, previousView: undefined });
    }
  },
};

export const generationGraphStore = {
  setData: store.setData,
  clearData: store.clearData,
  getState: useGenerationGraphStore.getState,
};
