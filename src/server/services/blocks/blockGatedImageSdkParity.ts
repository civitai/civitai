import type { BlockGatedImage as SdkBlockGatedImage } from '@civitai/app-sdk/blocks';

import type { BlockGatedImage } from '~/server/services/blocks/block-gated-images.service';

/**
 * App Blocks `BlockGatedImage` ↔ SDK wire-type PARITY gate.
 *
 * `BlockGatedImage` (`block-gated-images.service.ts`) is the shape
 * `blocks.getImagesByIds` puts on the wire, and `@civitai/app-sdk/blocks` carries
 * a COPY of it that deployed blocks compile against. A drift between the two is
 * not a type error anywhere else — it is a deployed block reading `undefined`
 * off a field its types promise is a `number`.
 *
 * This is the NON-TEST module (NOT `*.test.ts`) for the same reason
 * `src/components/AppBlocks/hostHandlerParity.ts` is: the assertions below are
 * TYPE-LEVEL, so they are only enforced if this file is in civitai's
 * `tsc --noEmit` / `next build` graph. A `*.test.ts` would not be. (It is also
 * NOT under `src/pages/**` — Next would treat that as a route.)
 *
 * It compares against the INSTALLED `@civitai/app-sdk` dist, so it catches a
 * server-side change immediately and an SDK-side change on the next bump of the
 * `@civitai/app-sdk` range in `package.json`. When the wire type changes, land
 * the matching SDK change (`civitai/civitai-app-starters`,
 * `packages/civitai-app-sdk/src/blocks/types.ts`), publish it, and bump the range
 * in the same PR as the server change.
 */

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
