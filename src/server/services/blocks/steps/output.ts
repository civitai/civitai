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

/**
 * True when `value` has the orchestrator `Blob` SHAPE — `available` plus `url`.
 *
 * A SHAPE test, not a key-name list and not a "does this string look like a
 * url?" sniff. The first draft of this module enumerated four key names
 * (`blob`/`blobs`/`image`/`images`) and called that auditable; measured against
 * the live spec on 2026-09-17 it covered 4 of the **19** property names that
 * carry a blob across the step types this bridge admits. The rest — `video`,
 * `audioBlob`, `svg`, `frames`, `tempBlobs`, `draftCache`, `additionalVideos`,
 * and seven on `polyGen` alone (`model`, `fbxModel`, `thumbnail`,
 * `riggedModel`, `riggedFbxModel`, `animatedModel`, `animatedFbxModel`,
 * `basicAnimations`) — would each have ridden out as a raw url inside the
 * forwarded output, i.e. exactly the second image channel this function exists
 * to prevent, on ~40% of the media-producing set.
 *
 * The shape is the orchestrator's own contract (`Blob` in `@civitai/client`), so
 * it covers a key nobody has seen yet, and it cannot strip prose: a string is
 * not an object with an `available` field.
 */
function isOrchestratorBlobLike(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'available' in (value as Record<string, unknown>) &&
    'url' in (value as Record<string, unknown>)
  );
}

/** True for a non-empty array whose every element has the blob shape. */
function isOrchestratorBlobList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(isOrchestratorBlobLike);
}

/**
 * Split an ARBITRARY orchestrator step output into the media it carries and
 * everything else — the pass-through arm's (`kind:'step'` with a bare `$type`)
 * one and only output rule.
 *
 * 🔴 THE STRIP IS UNCONDITIONAL, NOT "strip what produced media". A blob-shaped
 * value is removed from `rest` whether or not `mediaFromBlobs` kept it, so a
 * blob that the availability filter DROPPED — unavailable, blocked, empty url —
 * cannot ride out through `rest` instead. Filtering and stripping on the same
 * predicate is how a dead or blocked url reaches a block through the back door.
 *
 * 🔴 SOME STEP TYPES *ARE* A BLOB. `transcode` returns the blob itself as its
 * whole output (`TranscodeOutput` = `{ id, available, url, … }`), so the
 * top-level case is checked before the per-key walk. Without it that type's url
 * is the entire forwarded object.
 *
 * 🔴 DEPTH 1, AND THAT IS THE REAL LIMIT. A blob NESTED inside another object —
 * `training.epochs[]`, or a provider reply that embeds media inside a message —
 * still rides through `rest`. Recursing would mean rewriting the shape of an
 * object this arm promises to forward verbatim, which is a worse trade; the
 * bound is stated here rather than implied, and it is the thing to re-measure
 * when the catalog moves.
 */
export function splitPassThroughStepOutput(output: unknown): {
  media: StepOutputMedia[];
  rest: unknown;
} {
  if (output == null || typeof output !== 'object' || Array.isArray(output)) {
    return { media: [], rest: output };
  }
  if (isOrchestratorBlobLike(output)) {
    return { media: mediaFromBlobs(output as OrchestratorBlobLike), rest: {} };
  }
  const media: StepOutputMedia[] = [];
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if (isOrchestratorBlobLike(value) || isOrchestratorBlobList(value)) {
      media.push(...mediaFromBlobs(value as Parameters<typeof mediaFromBlobs>[0]));
      continue;
    }
    rest[key] = value;
  }
  return { media, rest };
}
