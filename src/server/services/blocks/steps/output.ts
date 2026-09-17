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
 * True when `value` has the orchestrator `Blob` SHAPE.
 *
 * A SHAPE test, not a key-name list and not a "does this string look like a
 * url?" sniff. The first draft of this module enumerated four key names
 * (`blob`/`blobs`/`image`/`images`); measured against the live spec on
 * 2026-09-17 those covered 4 of the 18 property names that carry a blob across
 * the step types this bridge admits, so `video`, `audioBlob`, `svg`, `frames`,
 * `tempBlobs`, `draftCache`, `additionalVideos` and seven on `polyGen` alone
 * would each have ridden out as a raw url inside the forwarded output.
 *
 * 🔴 KEYED ON `available` PLUS AN IDENTITY FIELD, NOT ON `available` PLUS `url`.
 * `Blob.available` and `Blob.id` are REQUIRED upstream; `url` is
 * `url?: null | string` — which is the whole premise the array rule below rests
 * on. Requiring `url` meant a BLOCKED blob, whose `url` key is simply absent,
 * failed the test and was forwarded whole: no url escaped (there is none), but
 * its `blockedReason` and raw orchestrator `nsfwLevel` did, and the module's own
 * "a blob that the filter DROPPED cannot ride out through `rest`" claim was
 * false. Measured.
 *
 * It still cannot strip prose: a string is not an object with an `available`
 * field.
 */
function isOrchestratorBlobLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return 'available' in v && ('url' in v || 'id' in v);
}

/**
 * The media a value carries, or `null` when it is not media at all.
 *
 * 🔴 AN ARRAY QUALIFIES IF **ANY** ELEMENT IS BLOB-SHAPED, NOT IF EVERY ONE IS.
 * The `every` spelling was measured to leak: one blocked sibling disqualified the
 * whole array, left the key unstripped, and forwarded every OTHER element's raw
 * url out through `rest` — the second image channel this module exists to
 * prevent, arriving through the very door the "unconditional strip" rule claims
 * is shut.
 *
 * Non-conforming elements of a qualifying array are DROPPED, not forwarded. That
 * is fail-safe, and it is not free: a sibling carrying real non-media data goes
 * with them, and the block gets no signal that anything was removed.
 */
function liftOrchestratorBlobs(value: unknown): StepOutputMedia[] | null {
  if (isOrchestratorBlobLike(value)) {
    return mediaFromBlobs(value as OrchestratorBlobLike);
  }
  if (Array.isArray(value) && value.some(isOrchestratorBlobLike)) {
    return mediaFromBlobs(value.filter(isOrchestratorBlobLike) as OrchestratorBlobLike[]);
  }
  return null;
}

/**
 * How deep the walk below descends before it stops looking.
 *
 * 🔴 NOT 1, AND THE REASON IS A MEASUREMENT. A depth-1 walk was shipped and then
 * measured against the live spec: of the 50 step types, three carry blobs deeper
 * than the top level, and two of them are ALLOWED on this arm.
 * `polyGen.basicAnimations` is a plain object holding SIX `Model3DBlob`s
 * (walking/running × three model formats) and `training.epochs[]` carries
 * `model` plus a `samples[]` of images/videos/audio. Every one of those urls was
 * forwarded raw, i.e. reachable by the app and invisible to both the publish
 * path and the per-viewer gated read.
 *
 * 4 clears every shape in the catalog today with room, and bounds the walk so an
 * adversarial payload cannot make it unbounded — the input is app-supplied and
 * only size-capped.
 */
const PASS_THROUGH_OUTPUT_WALK_DEPTH = 4;

/**
 * Strip every blob-shaped value out of an orchestrator step output, returning
 * the media found and the remainder — the pass-through arm's one output rule.
 *
 * 🔴 THE STRIP IS UNCONDITIONAL, NOT "strip what produced media". A blob-shaped
 * value is removed whether or not `mediaFromBlobs` kept it, so a blob the
 * availability filter DROPPED — unavailable, blocked, empty or absent url —
 * cannot ride out through the remainder instead. Filtering and stripping on the
 * same predicate is how a dead or blocked url reaches a block through the back
 * door. 🔴 `liftOrchestratorBlobs` returning an EMPTY array is what implements
 * that: `[]` is truthy, and the truthiness is load-bearing. A "simplification"
 * to `if (lifted?.length)` reopens the door.
 *
 * 🔴 SOME STEP TYPES *ARE* A BLOB. `transcode` returns the blob itself as its
 * whole output, so the whole-value case is checked before descending.
 */
export function splitPassThroughStepOutput(output: unknown): {
  media: StepOutputMedia[];
  rest: unknown;
} {
  const media: StepOutputMedia[] = [];
  const rest = walkPassThroughOutput(output, media, 0);
  return { media, rest };
}

function walkPassThroughOutput(value: unknown, media: StepOutputMedia[], depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  const lifted = liftOrchestratorBlobs(value);
  if (lifted) {
    media.push(...lifted);
    return Array.isArray(value) ? [] : {};
  }
  // Past the cap the value is forwarded as-is. A deeper blob than the catalog
  // has ever carried is the accepted residue of a bounded walk; see
  // PASS_THROUGH_OUTPUT_WALK_DEPTH.
  if (depth >= PASS_THROUGH_OUTPUT_WALK_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => walkPassThroughOutput(entry, media, depth + 1));
  }
  const rest: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const entryLifted = liftOrchestratorBlobs(entry);
    if (entryLifted) {
      media.push(...entryLifted);
      continue;
    }
    rest[key] = walkPassThroughOutput(entry, media, depth + 1);
  }
  return rest;
}
