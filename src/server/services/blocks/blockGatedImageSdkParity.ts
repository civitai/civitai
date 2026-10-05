import type { BlockGatedImage } from '~/server/services/blocks/block-gated-images.service';

/**
 * App Blocks `BlockGatedImage` ↔ SDK wire-type PARITY gate.
 *
 * `BlockGatedImage` (`block-gated-images.service.ts`) is the shape
 * `blocks.getImagesByIds` puts on the wire, and `@civitai/app-sdk/blocks` carries
 * a COPY of it that deployed blocks compile against. That type's docstring has
 * said *"Mirrors `@civitai/app-sdk/blocks`' `BlockGatedImage` — keep in
 * lockstep"* since it was written, and NOTHING ENFORCED IT: the two drifted the
 * moment the server gained the `ratingPending` shape, and a drift here is not a
 * type error anywhere — it is a deployed block reading `undefined` off a field
 * its types promise is a `number`.
 *
 * This is the NON-TEST module (NOT `*.test.ts`) for the same reason
 * `src/components/AppBlocks/hostHandlerParity.ts` is: the assertions below are
 * TYPE-LEVEL, so they are only enforced if this file is in civitai's
 * `tsc --noEmit` / `next build` graph. A `*.test.ts` would not be. (It is also
 * NOT under `src/pages/**` — Next would treat that as a route.)
 *
 * 🔴 WHY A VENDORED COPY RATHER THAN THE INSTALLED PACKAGE. The obvious guard —
 * `import type { BlockGatedImage } from '@civitai/app-sdk/blocks'` — cannot be
 * written today: the PUBLISHED `@civitai/app-sdk` this repo depends on (0.14.0)
 * does not export `BlockGatedImage` at all; the type exists only in the
 * `civitai-app-starters` SOURCE. Importing it would make this file a permanent
 * compile error, and a permanently-red gate is worse than no gate. So the SDK's
 * declaration is VENDORED below, byte-for-byte, and the compiler compares the
 * two structurally. The same one-directional-vs-published trade-off
 * `hostHandlerParity.ts` documents: the inventory here may be AHEAD of the
 * published dist, and that is the normal state while an SDK co-requisite is in
 * review.
 *
 * 🔴 WHAT THIS BUYS AND WHAT IT DOES NOT. It makes it IMPOSSIBLE to change the
 * server's wire type without this file failing to compile — which is the review
 * trigger that did not exist before. It does NOT read the real SDK, so it cannot
 * tell you the vendored copy is stale; the human step it forces is "paste the
 * SDK's current declaration here, and if it disagrees, open the SDK PR".
 *
 * MAINTENANCE, when the wire type changes:
 *   1. open the co-requisite PR in `civitai/civitai-app-starters`
 *      (`packages/civitai-app-sdk/src/blocks/types.ts`),
 *   2. paste that PR's `BlockGatedImage` body into {@link SdkBlockGatedImage}
 *      below (renaming only the type, and inlining `ContentRating`),
 *   3. update {@link SDK_MIRROR_SOURCE} to the ref you copied from.
 */

/**
 * WHERE the vendored declaration below was copied from. Update alongside it.
 * Not load-bearing at runtime — it is the provenance a reviewer needs to check
 * the paste.
 */
export const SDK_MIRROR_SOURCE =
  'civitai/civitai-app-starters — packages/civitai-app-sdk/src/blocks/types.ts (BlockGatedImage)';

/**
 * The SDK's `ContentRating` (civitai/civitai-app-starters,
 * `packages/civitai-app-sdk/src/blocks/types.ts` — NOT a path in this repo),
 * inlined so this module needs nothing from the installed package. This repo's
 * `OffsiteRatingValue` must equal it — the `contentRating` field crosses the wire
 * typed as one and is read as the other.
 */
type SdkContentRating = 'g' | 'pg' | 'pg13' | 'r' | 'x';

/**
 * 🔴 VENDORED BYTE-COPY of `@civitai/app-sdk/blocks`' `BlockGatedImage`. The only
 * edits permitted relative to the SDK source are the type's NAME and inlining
 * `ContentRating` as {@link SdkContentRating}. Do not "tidy" it toward this
 * repo's spelling — the point is that a difference is a compile error.
 */
type SdkBlockGatedImage =
  | {
      imageId: number;
      status: 'visible';
      /** Scanner-resolved NSFW-level bitmask value. ABSENT on a `ratingPending` entry. */
      nsfwLevel?: number;
      /** Off-site content rating (`'g'|'pg'|'pg13'|'r'|'x'`). ABSENT on a `ratingPending` entry. */
      contentRating?: SdkContentRating;
      /** Civitai-hosted image URL (only present for a viewer allowed to see it). */
      url: string;
      width: number | null;
      height: number | null;
      /** Present ONLY on the viewer's OWN image that nothing has rated yet. */
      ratingPending?: true;
    }
  | {
      imageId: number;
      status: 'hidden';
    };

// ─────────────────────────────────────────────────────────────────────────────
// The gate. Each assertion below is a `const X: <computed type> = true`, so a
// mismatch is a TypeScript error whose TYPE spells out what drifted.
// ─────────────────────────────────────────────────────────────────────────────

/** `true` only when A and B are the same type in BOTH directions. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * The keys of `T` that are NOT optional. (`Pick<T, K>` loses its `?` under
 * `Required<>`, so the two differ exactly when `K` is optional.)
 */
type RequiredKeys<T> = {
  [K in keyof T]-?: Pick<T, K> extends Required<Pick<T, K>> ? K : never;
}[keyof T];

/** The keys of `T` that ARE optional. */
type OptionalKeys<T> = Exclude<keyof T, RequiredKeys<T>>;

type RepoVisible = Extract<BlockGatedImage, { status: 'visible' }>;
type SdkVisible = Extract<SdkBlockGatedImage, { status: 'visible' }>;
type RepoHidden = Extract<BlockGatedImage, { status: 'hidden' }>;
type SdkHidden = Extract<SdkBlockGatedImage, { status: 'hidden' }>;

/**
 * 🔴 THE WIRE CARRIES EXACTLY TWO STATUSES. The per-row verdict
 * (`classifyGatedImageForViewer`) has a third, `pending`, and it is deliberately
 * consumed in the service and never emitted: a non-author sees the same `hidden`
 * they saw before this change. Re-adding `pending` to the wire is a DISCLOSURE
 * decision (it turns every remaining `hidden` into a positive "a rating exists
 * and it is above your ceiling"), so it must fail here and be re-decided, not
 * slip in as a type widening.
 */
type _StatusSetIsClosed = Exact<BlockGatedImage['status'], 'visible' | 'hidden'>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _statusSetIsClosed: _StatusSetIsClosed = true;

/** The two declarations must agree on which statuses exist at all. */
type _StatusesMatch = Exact<BlockGatedImage['status'], SdkBlockGatedImage['status']>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _statusesMatch: _StatusesMatch = true;

/**
 * Per-variant FIELD-SET parity, split required-vs-optional. Mutual assignability
 * alone is NOT enough here: an extra OPTIONAL property on one side is still
 * structurally assignable to the other, so `ratingPending` could exist on one
 * copy and not the other with no error. These four catch that.
 */
type _VisibleRequiredMatch = Exact<RequiredKeys<RepoVisible>, RequiredKeys<SdkVisible>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _visibleRequiredMatch: _VisibleRequiredMatch = true;

type _VisibleOptionalMatch = Exact<OptionalKeys<RepoVisible>, OptionalKeys<SdkVisible>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _visibleOptionalMatch: _VisibleOptionalMatch = true;

type _HiddenRequiredMatch = Exact<RequiredKeys<RepoHidden>, RequiredKeys<SdkHidden>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _hiddenRequiredMatch: _HiddenRequiredMatch = true;

type _HiddenOptionalMatch = Exact<OptionalKeys<RepoHidden>, OptionalKeys<SdkHidden>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _hiddenOptionalMatch: _HiddenOptionalMatch = true;

/**
 * Field-set parity does not constrain the field TYPES, so assert those too —
 * mutually, so neither side may widen or narrow alone. This is what catches
 * `nsfwLevel: number` on one side and `nsfwLevel: string` on the other, and
 * (with the optional-key checks above) `nsfwLevel: number` vs `nsfwLevel?:
 * number` — the exact drift this change introduces, and the reason a deployed
 * block can now read `undefined` where its types promise a `number`.
 */
type _ShapesMatch = Exact<BlockGatedImage, SdkBlockGatedImage>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _shapesMatch: _ShapesMatch = true;
