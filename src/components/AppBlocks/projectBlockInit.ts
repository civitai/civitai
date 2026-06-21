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
 * Build the BLOCK_INIT `viewer` object from the slot context.
 *
 * `id` and `username` are documented contract fields blocks use for
 * personalization. The viewer's `status` (ban/mute moderation state) is
 * intentionally NOT sent: no block consumes it, and exposing a viewer's
 * moderation state to untrusted third-party publisher code is a privacy leak
 * with no benefit — a block's authoritative check is its own
 * `/api/v1/blocks/me` call.
 *
 * Returns `null` for anonymous viewers (no numeric viewer id).
 */
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

export function projectBlockInitViewer(
  context: SlotContext
): BlockInitPayload['viewer'] {
  const source = context as Partial<ModelSlotContext>;
  if (typeof source.viewerUserId !== 'number') return null;
  return {
    id: source.viewerUserId,
    username: source.viewerUsername ?? null,
  };
}
