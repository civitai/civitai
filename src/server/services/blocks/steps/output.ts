// ─────────────────────────────────────────────────────────────────────────────
// Step OUTPUT extraction primitives — a LEAF module, imported by both the
// registry (`./index`) and every entry (`./<name>.step`).
//
// 🔴 WHY THIS IS NOT IN `./index`. `index.ts` imports each entry to build the
// registry object, so an entry importing a VALUE back out of `index.ts` is a
// runtime import cycle. The existing `import type { BlockStep } from './index'`
// is fine — types erase — but `mediaFromBlobs` is a real function, and a cycle
// whose safety rests on function-declaration hoisting is one transpiler setting
// away from a `undefined is not a function` on a read path. A leaf module has no
// cycle to reason about.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One piece of output media a registered step produced.
 *
 * Serves BOTH `workflow.service` extractors from one call, which is what makes
 * "register a step" and "its result is retrievable" the same action:
 * `snapshotFromWorkflow` reads `url`, `projectAppWorkflow` reads all four.
 *
 * `nsfwLevel` is the RAW orchestrator content-rating string (`'pg13'`, `'na'`,
 * …), NOT the numeric civitai browsing-level bitflag. Mapping it is the
 * projection's job and stays in exactly one place
 * (`nsfwLevelFromContentRating`) — a registry entry must not be able to invent
 * its own mapping.
 *
 * 🔴 `url` IS A BARE STRING AND NOTHING VALIDATES IT AS A URL. It reaches
 * `snapshot.imageUrls` and `AppWorkflow.images[].url` unfiltered, and NEITHER of
 * those passes through `attachModeratedStepTextOutputs` — so anything an entry
 * puts here is published unscanned. That is why the registry forbids a
 * text-posture entry from declaring `extractOutput` at all
 * (`TextOutputSurface`, registry clause 8-ii, and the posture gate on both
 * `workflow.service` extractors) rather than trying to police the string.
 */
export type StepOutputMedia = {
  url: string;
  width: number | null;
  height: number | null;
  nsfwLevel: string | null;
};

/** The orchestrator blob shape every media-producing step output shares. */
export type OrchestratorBlobLike = {
  url?: string | null;
  available?: boolean;
  width?: number | null;
  height?: number | null;
  nsfwLevel?: string | null;
};

/**
 * Blobs → `StepOutputMedia[]`, applying the availability + non-empty-url filter.
 *
 * 🔴 EXPORTED SO EVERY ENTRY USES ONE COPY OF THE FILTER. The rule — "only blobs
 * that are `available` with a non-null url are surfaced; pending/blocked ones
 * are dropped rather than handing the block dead links" — is the same rule the
 * two `workflow.service` extractors already applied inline. A per-entry
 * reimplementation is how one copy gets a fix and the others don't.
 *
 * Tolerates a single blob, a list, or absent: `convertImage` returns
 * `{ blob }` (SINGULAR), `customComfy` returns `{ blobs }`.
 */
export function mediaFromBlobs(
  blobs:
    | OrchestratorBlobLike
    | readonly (OrchestratorBlobLike | null | undefined)[]
    | null
    | undefined
): StepOutputMedia[] {
  const list: readonly (OrchestratorBlobLike | null | undefined)[] =
    blobs == null ? [] : Array.isArray(blobs) ? blobs : [blobs as OrchestratorBlobLike];
  const media: StepOutputMedia[] = [];
  for (const blob of list) {
    if (!blob) continue;
    if (!blob.available || typeof blob.url !== 'string' || blob.url.length === 0) continue;
    media.push({
      url: blob.url,
      width: typeof blob.width === 'number' ? blob.width : null,
      height: typeof blob.height === 'number' ? blob.height : null,
      nsfwLevel: typeof blob.nsfwLevel === 'string' ? blob.nsfwLevel : null,
    });
  }
  return media;
}
