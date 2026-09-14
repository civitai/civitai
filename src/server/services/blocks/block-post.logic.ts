/**
 * App Blocks → real Post (`blocks.createPostFromApp` / `CREATE_POST_FROM_APP`) —
 * the PURE half. Everything here is a total function of its inputs: no Prisma, no
 * Redis, no orchestrator, no `TRPCError`. Extracted for the same reason
 * `block-gated-images.logic.ts` and `block-image-upload.logic.ts` were: the
 * load-bearing decisions on this path are text bounds, tag policy and source
 * normalisation, and all three are cheap to get subtly wrong and expensive to
 * test through a DB.
 *
 * The IMPURE half — ownership proofs, provenance reads, the self-dealing guard,
 * the transaction — is `block-post.service.ts`.
 */

// TYPE-ONLY, and that is what keeps this module pure: the import is erased at
// compile time, so nothing in `workflow.service`'s runtime dependency graph is
// pulled in here. It exists so `BLOCK_POST_TERMINAL_WORKFLOW_STATUSES` is checked
// against the real wire contract instead of a hand-copied literal union.
import type { AppWorkflow } from '~/server/services/blocks/workflow.service';

/** Hard ceiling on images in ONE app-created post. */
export const BLOCK_POST_MAX_IMAGES = 20;

/**
 * Hard ceiling on `sources[]` entries. Each `workflow` entry costs one
 * orchestrator `getWorkflow` round-trip plus a DB ownership read, so the bound is
 * about fan-out, not about the image cap (which bounds the result).
 */
export const BLOCK_POST_MAX_SOURCES = 10;

/**
 * Server-side text bounds. The NATIVE post schema has NONE
 * (`postCreateSchema` puts no `.max()` on `title`/`detail`), so these are
 * deliberately stricter than native rather than a copy of it: a sandboxed third
 * party writing unbounded prose under the viewer's byline is a different risk
 * from a human typing into their own editor.
 */
export const BLOCK_POST_TITLE_MAX = 255;
export const BLOCK_POST_DETAIL_MAX = 2000;

/** Hard ceiling on applied tags. Native has no cap; this one does. */
export const BLOCK_POST_MAX_TAGS = 5;

/**
 * The block→host wire shape for one image source, after host-side sanitisation.
 *
 * TWO kinds, and that is an OPERATOR DECISION rather than a requirement the
 * problem forced: the eligible images for an app-created post are the app's OWN
 * workflow outputs AND images the app previously published. The alternative on
 * the table was the narrower one — fresh workflow outputs only, with previously
 * published images reachable only by re-generating them — and it was rejected
 * because an app whose whole shape is "publish to the grid, then let the viewer
 * post the one they like" could not be built on it.
 *
 * `PUBLISH_GENERATION_OUTPUTS` cannot express two kinds at all (its `workflowId`
 * is a single required string), which is the shape half of why this is a sibling
 * message rather than an extension of that one.
 */
export type BlockPostSource =
  | { kind: 'workflow'; workflowId: string; imageIndexes?: number[] }
  | { kind: 'published'; imageIds: number[] };

export type BlockPostTextValidation =
  | { ok: true; title: string | null; detail: string | null }
  | { ok: false; reason: string };

/**
 * A URL anywhere in `detail`, in the forms a sandboxed block would actually reach
 * for. Deliberately BROAD and deliberately not a parser: this is a REFUSAL
 * predicate, so a false positive costs an app a rewrite and a false negative
 * costs the viewer a phishing link published under their own name.
 *
 * 🔴 WHY REFUSE URLS AT ALL, when the platform already has a link blocklist.
 * `throwOnBlockedUserContent`'s link half is a DENY-list of known-bad domains —
 * it answers "is this a domain we have already decided is bad", not "should a
 * third-party app be able to publish outbound links as this user". Those are
 * different questions and only the second one is ours. Both run: this predicate
 * first, the blocklist after.
 *
 * ⚠️ WHAT IT CANNOT SEE, stated rather than implied: a bare domain with no scheme
 * and no `www.` and no slash (`example.com` alone matches the `\bexample\.com`
 * arm via the TLD alternative, but an exotic TLD may not), a unicode-homoglyph
 * domain, and text that only becomes a link because some renderer linkifies it.
 * It is a bound on the obvious case, not a proof.
 */
const URL_LIKE_RE =
  /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|ai|xyz|app|dev|me|ru|cn|gg|link|click|top|site|online|shop)\b)/i;

/**
 * Normalise + bound the block-supplied copy. Returns the EXACT strings that will
 * be written, so the host confirm can render the same value the server will
 * persist — if this returned one thing and the writer wrote another, the confirm
 * would be a ceremony rather than a consent screen.
 *
 * Empty/whitespace collapses to `null` (no title is a valid post), which is why
 * the return type is nullable rather than the input echoed back.
 */
export function validateBlockPostText(input: {
  title?: string | null;
  detail?: string | null;
}): BlockPostTextValidation {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const detail = typeof input.detail === 'string' ? input.detail.trim() : '';

  if (title.length > BLOCK_POST_TITLE_MAX) {
    return { ok: false, reason: `title exceeds ${BLOCK_POST_TITLE_MAX} characters` };
  }
  if (detail.length > BLOCK_POST_DETAIL_MAX) {
    return { ok: false, reason: `detail exceeds ${BLOCK_POST_DETAIL_MAX} characters` };
  }
  if (detail.length > 0 && URL_LIKE_RE.test(detail)) {
    return { ok: false, reason: 'detail may not contain links' };
  }
  if (title.length > 0 && URL_LIKE_RE.test(title)) {
    return { ok: false, reason: 'title may not contain links' };
  }

  return {
    ok: true,
    title: title.length > 0 ? title : null,
    detail: detail.length > 0 ? detail : null,
  };
}

/**
 * Normalise requested tag NAMES: lowercase, trim, drop empties, dedupe, cap.
 * Resolution against real `Tag` rows happens in the service — this only decides
 * WHICH names are worth looking up.
 *
 * The cap is applied AFTER dedupe so a block cannot burn the budget by repeating
 * one name.
 */
export function normalizeBlockPostTagNames(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const name = raw.toLowerCase().trim();
    if (name.length === 0 || name.length > 100) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= BLOCK_POST_MAX_TAGS) break;
  }
  return out;
}

/**
 * Resolve a block's requested output selection for ONE workflow against the
 * outputs the server actually projected, mirroring `publishGenerationOutputs`'
 * selection rules (in-range, deduped, request-ordered) — EXCEPT that this returns
 * the chosen INDEXES rather than the outputs, so the caller owns the projection
 * type.
 *
 * ⚠️ ONE DELIBERATE DIVERGENCE from the publish path, and it is the only one:
 * publish SILENTLY TRUNCATES at its cap via `break`. Truncation is defensible for
 * a grid (you get fewer tiles); it is not defensible for a post, where the viewer
 * is shown thumbnails in a confirm and then agrees to publish THAT SET. Silently
 * dropping images between the confirm and the write would make the confirm lie.
 * So the cap is enforced by the CALLER as a refusal across all sources, and this
 * function never truncates — `maxCount` exists only to bound one source's
 * contribution and is passed the remaining budget.
 */
export function resolveWorkflowOutputSelection(input: {
  requested: number[] | undefined;
  availableCount: number;
  maxCount: number;
}): number[] {
  const { requested, availableCount, maxCount } = input;
  const raw = requested ?? Array.from({ length: availableCount }, (_, i) => i);
  const selected: number[] = [];
  const seen = new Set<number>();
  for (const idx of raw) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= availableCount) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    selected.push(idx);
    if (selected.length >= maxCount) break;
  }
  return selected;
}

/**
 * The workflow statuses from which a post may draw outputs: the TERMINAL ones.
 *
 * 🔴 THIS IS THE PRIMARY INVARIANT BEHIND THE PREVIEW/WRITE CONSENT GUARANTEE,
 * AND IT WORKS BY REMOVING THE RACE RATHER THAN DETECTING IT. The preview and the
 * write resolve `sources` independently, and a `workflow` source with no
 * `imageIndexes` means "every available output" — so a workflow that is still
 * RUNNING can gain an output between the two phases, and the viewer who was shown
 * N thumbnails gets a post with N+1 images. Nothing about that is an
 * authorization failure; every check still passes. It is the CONFIRM becoming
 * inaccurate, which is the one thing the confirm exists to prevent.
 *
 * A workflow that has reached a terminal state produces no further outputs, so
 * both phases necessarily see the same set. Refusing a non-terminal source is
 * therefore the generator-level fix: it costs ZERO extra IO (the status is
 * already on the projection `resolveOwnedWorkflowOutputs` reads) and it binds
 * EVERY caller, including ones that never render a consent dialog.
 *
 * ⚠️ WHY `failed` / `expired` / `canceled` ARE ADMITTED and not only `succeeded`.
 * The property that matters here is that the output set is FROZEN, and it is
 * frozen in all four. A partially-successful workflow that produced usable,
 * allowlisted blobs is postable content; narrowing this to `succeeded` would be a
 * product change wearing a safety guard's clothes. What is refused is exactly the
 * set that can still change: `pending` and `processing`.
 *
 * The `satisfies` binds this list to the wire contract — renaming or dropping a
 * status in `AppWorkflow` breaks the build here rather than silently widening the
 * gate to an unlisted status.
 */
export const BLOCK_POST_TERMINAL_WORKFLOW_STATUSES = [
  'succeeded',
  'failed',
  'expired',
  'canceled',
] as const satisfies readonly AppWorkflow['status'][];

/**
 * True when a workflow can no longer gain or lose outputs. See
 * `BLOCK_POST_TERMINAL_WORKFLOW_STATUSES`.
 *
 * Takes a plain `string` on purpose: the orchestrator is an external system and
 * an UNRECOGNISED status must read as non-terminal (fail closed), not fall
 * through a union-typed parameter that TypeScript believes is exhaustive.
 */
export function isTerminalBlockPostWorkflowStatus(status: string): boolean {
  return (BLOCK_POST_TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(status);
}

/**
 * The host-rendered consent payload. EVERY field here is resolved SERVER-SIDE
 * from ids the server verified — `tags` are the names that will actually be
 * applied (not the ones requested), `gallery` is the host-fetched model/version
 * name (never a block-supplied label), and `images` are host-resolved urls.
 *
 * 🔴 THIS TYPE IS THE CONSENT CONTRACT. A field added here that the block can
 * influence directly turns the confirm back into a ceremony. See
 * `createPostFromAppGate.ts` for the doctrine and `collectionFollowGate.ts:215`
 * for the precedent it is copied from.
 */
export type BlockPostPreview = {
  title: string | null;
  detail: string | null;
  /** Names that WILL be applied (existing tags only). */
  tags: string[];
  /** Requested names that resolved to nothing and will be silently dropped. */
  droppedTags: string[];
  /** Host-resolved thumbnails, in post order. */
  images: Array<{ url: string; width: number | null; height: number | null }>;
  /** Host-resolved gallery target, or null when no `modelVersionId` was asked for. */
  gallery: { modelVersionId: number; modelName: string; versionName: string } | null;
};
