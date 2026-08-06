/**
 * BLOCK_INIT data-minimization projection (security audit — MEDIUM).
 *
 * The host posts a single BLOCK_INIT message to the third-party publisher
 * iframe. The transport is safe (exact-origin postMessage, event.source-pinned
 * — see usePostMessage), but the payload itself must not over-share: the
 * publisher's code legitimately receives this object, so it must carry ONLY the
 * fields the documented `@civitai/app-sdk/blocks` v1 contract defines, never the
 * incidental PII / internal ids that happen to ride along on the host's
 * `SlotContext`.
 *
 * Before this projection, IframeHost spread the ENTIRE slot context
 * (`{ ...context, checkpoint, showcaseImages }`) into BLOCK_INIT.context. That
 * leaked, to untrusted publisher code:
 *   - `viewerNsfwEnabled` — the viewer's NSFW preference (privacy-sensitive; no
 *      block renders against it).
 *   - `creatorUserId` — the model owner's internal numeric user id.
 *   - `viewerUserId` / `viewerUsername` — duplicated in raw form (the `viewer`
 *      object carries id/username intentionally).
 *   - `viewerStatus` — viewer ban/mute moderation state; not forwarded to the
 *      iframe at all (dropped from both context and the `viewer` object).
 *
 * The fix is an explicit ALLOWLIST: only the contract fields below are copied
 * into the projected context; everything else is dropped. Default-to-drop — a
 * new field added to SlotContext does not reach the iframe until it is added
 * here on purpose.
 *
 * These are pure functions (no React, no postMessage) so the allowlist is
 * unit-testable in isolation — see __tests__/projectBlockInit.test.ts.
 */
import type {
  BlockCheckpointInfo,
  BlockInitPayload,
  ModelSlotContext,
  ShowcaseImage,
  SlotContext,
} from './types';

/**
 * Context fields that are part of the BLOCK_INIT contract and safe to forward
 * to the iframe. Anything NOT in this list is dropped by the projection.
 *
 * Kept (model-rendering + presentation fields a block renders against):
 *   slotId, modelId, modelVersionId, modelName, modelType, modelNsfwLevel,
 *   theme, checkpoint, showcaseImages.
 *
 * Deliberately ABSENT (over-share — dropped):
 *   creatorUserId       internal owner user id, no block needs it
 *   viewerNsfwEnabled   viewer privacy preference
 *   viewerUserId        duplicate of viewer.id
 *   viewerStatus        viewer ban/mute state — not sent to the iframe at all
 *   viewerUsername      duplicate of viewer.username
 */
const CONTEXT_ALLOWLIST = [
  'slotId',
  'modelId',
  'modelVersionId',
  'modelName',
  'modelType',
  'modelNsfwLevel',
  'theme',
] as const;

/**
 * Project a slot context down to the contract allowlist, then layer in the
 * host-resolved render extras (effective checkpoint + showcase images). The
 * extras are added explicitly (not spread from `context`) so they're always
 * the host-authoritative values, never whatever a producer happened to set.
 *
 * Returns a fresh object — the input `context` is never mutated.
 */
export function projectBlockInitContext(
  context: SlotContext,
  extras: {
    checkpoint: BlockCheckpointInfo | null;
    showcaseImages: ShowcaseImage[];
  }
): SlotContext {
  const source = context as Partial<ModelSlotContext> & SlotContext;
  // slotId is required by SlotContext; everything else is copied only when the
  // source actually carries it (non-model slots omit the model fields).
  const projected: SlotContext = { slotId: source.slotId };
  for (const key of CONTEXT_ALLOWLIST) {
    if (key === 'slotId') continue;
    if (key in source && source[key] !== undefined) {
      projected[key] = source[key];
    }
  }
  // Host-resolved extras override anything the producer may have set.
  projected.checkpoint = extras.checkpoint;
  projected.showcaseImages = extras.showcaseImages;
  return projected;
}

/**
 * Project the color-domain maturity signal into the BLOCK_INIT contract fields.
 *
 * These are ADVISORY (block self-filtering / blur). The values are the
 * server-authoritative ones the token mint computed from the request host
 * (`getRequestDomainColor` → `domainBrowsingCeiling`) and returned alongside
 * the token — the host never derives them client-side, it forwards them. The
 * AUTHORITATIVE maturity enforcement is the server generation clamp keyed on
 * the same value baked into the token claim.
 *
 * Defaults are FAIL-CLOSED: an absent ceiling projects `undefined` (the SDK
 * `useDomainMaturity()` hook treats absent as the most restrictive), and an
 * unrecognized domain projects `null` rather than leaking a raw value.
 */
export function projectBlockInitMaturity(input: {
  domain?: string | null;
  maxBrowsingLevel?: number | null;
}): Pick<BlockInitPayload, 'domain' | 'maxBrowsingLevel'> {
  const domain =
    input.domain === 'green' || input.domain === 'blue' || input.domain === 'red'
      ? input.domain
      : null;
  const maxBrowsingLevel =
    typeof input.maxBrowsingLevel === 'number' && Number.isFinite(input.maxBrowsingLevel)
      ? input.maxBrowsingLevel
      : undefined;
  return { domain, maxBrowsingLevel };
}

/**
 * Stamp the BLOCK_INIT `viewer` object with the v2 `signedIn` flag.
 *
 * 🔴 THIS EXISTS BECAUSE THERE ARE TWO PRODUCERS OF THAT OBJECT, NOT ONE.
 * `IframeHost` (the model-slot surface) derives the viewer from the slot context
 * via `projectBlockInitViewer` below. `PageBlockHost` (the W10 full-page
 * surface) does NOT — it receives an already-resolved `viewer` PROP from the run
 * route and passes it straight into `buildInitPayload`. The two hosts share no
 * bridge (the gotcha-#73 class `hostHandlerParity.ts` documents), so a flag
 * added inside `projectBlockInitViewer` alone reaches exactly half the fleet.
 * Both paths funnel through THIS function so the stamped shape cannot drift.
 *
 * `signedIn` is the literal `true`, never a computed boolean: a present
 * ViewerInfo IS a signed-in viewer — the host has no way to produce a viewer
 * object for an anonymous session — so a computed value could only ever be
 * `true` or a bug. Anonymous is represented by the ABSENCE of the object
 * (`null`), which is the shape the deployed `isValidBlockInitPayload` guard
 * requires; see BlockInitPayload.viewer.
 *
 * `id` / `username` are DEPRECATED but still stamped through unchanged — the
 * deployed guard requires the numeric `id`, and 5 of the 9 currently-approved
 * apps read it for load-bearing logic. See the field docs on
 * BlockInitPayload.viewer.
 *
 * 🔴 `username` IS COALESCED TO `null`, NOT PASSED THROUGH RAW. An `undefined`
 * username serialises to an ABSENT key over postMessage (structured clone drops
 * `undefined` object values), and the deployed `isValidBlockInitPayload` guard
 * distinguishes the two: an explicit `null` is accepted, an ABSENT `username` is
 * rejected. Executed against the guards extracted from the deployed bundles, an
 * absent `username` was rejected by 16 of 16 and an explicit `null` accepted by
 * all 16. A rejected payload means the block never initialises at all. No
 * current caller can pass `undefined` (the parameter type forbids it and all
 * three call sites already coalesce), but this helper is the single choke point
 * BOTH hosts funnel through, so the coalesce lives here rather than depending on
 * every future caller remembering it.
 *
 * 🔴 THE FIELDS ARE PICKED EXPLICITLY, NEVER SPREAD. `{ ...viewer, signedIn }`
 * would pass every shape assertion written against a narrow fixture while
 * forwarding whatever else the caller's object happens to carry — and the
 * PageBlockHost caller's `viewer` is a route-supplied object, not one this module
 * built. The projection is the data-minimisation property this module exists for,
 * and it is pinned by a test that feeds a DELIBERATELY WIDER viewer object than
 * any host produces — a narrow fixture cannot tell a pick from a spread.
 */
export function withSignedInFlag(
  viewer: { id: number; username: string | null } | null | undefined
): BlockInitPayload['viewer'] {
  if (!viewer) return null;
  return {
    id: viewer.id,
    username: viewer.username ?? null,
    signedIn: true,
  };
}

/**
 * Build the BLOCK_INIT `viewer` object from the slot context (the model-slot
 * host's path — see `withSignedInFlag` for why there are two).
 *
 * The viewer's `status` (ban/mute moderation state) is intentionally NOT sent:
 * no block consumes it, and exposing a viewer's moderation state to untrusted
 * third-party publisher code is a privacy leak with no benefit — a block's
 * authoritative check is its own `/api/v1/blocks/me` call.
 *
 * Returns `null` for anonymous viewers (no numeric viewer id).
 */
export function projectBlockInitViewer(context: SlotContext): BlockInitPayload['viewer'] {
  const source = context as Partial<ModelSlotContext>;
  if (typeof source.viewerUserId !== 'number') return null;
  return withSignedInFlag({
    id: source.viewerUserId,
    username: source.viewerUsername ?? null,
  });
}
