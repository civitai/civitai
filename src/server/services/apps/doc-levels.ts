/**
 * CONTENT LEVELS of App Blocks shared documents: where the flag is read and where each reader's
 * level comes from. The SQL predicate itself is `sharedDocLevelVisible` in `doc-store.ts`, its one
 * definition; this module only decides WHETHER the store applies it and WITH WHICH LEVEL.
 *
 * - The flag: `app-blocks-shared-doc-levels`, evaluated per app (entity id = the app block id
 *   whose documents are read or written, NO context), like the shared-data moderation flags. Off,
 *   the store's context carries no `levels` and every statement is the one it ran before. A flag
 *   that cannot be read counts as on ({@link isSharedDocLevelsOn}).
 * - A block-token reader (the storage REST routes): the token's viewer level
 *   ({@link viewerDocLevel}) for other people's documents, and the token's domain ceiling
 *   ({@link domainDocLevel}) for the reader's own rated documents.
 * - The registry feed: the subscription's audience ({@link audienceDocLevel}).
 * - The server key lookup is level-blind: it reports each item's rating (asked for while the flag
 *   is on) and App Store publishing decides on it; spend attribution ignores it.
 *
 * Levels are the site's NsfwLevel bits and a viewer level is a bitwise set of them; a document is
 * within it when its one level bit is in the set (the site's bitwise browsing-level semantics).
 */
import { NsfwLevel } from '~/server/common/enums';
import { FLIPT_FEATURE_FLAGS, readFliptBoolean } from '~/server/flipt/client';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import type { StorageAccess } from '~/server/services/apps/doc-store-access';
import type { DocLevelGate } from '~/server/services/apps/doc-store.types';
import { resolveViewerBrowsingLevel } from '~/server/services/blocks/block-viewer-ceiling';
import {
  onlySelectableLevels,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * Whether content levels are on for the app whose shared documents are being read or written.
 * FAILS CLOSED: a flag that cannot be read (Flipt unreachable with no stored snapshot, or the key
 * missing) counts as ON, so unrated and over-level documents stay hidden from viewers who are not
 * allowed them. Only a flag that reads `false` turns levels off. Every gate reads this one answer:
 * the storage routes, the server key lookup, the card decisions and the registry feed.
 */
export async function isSharedDocLevelsOn(appBlockId: string): Promise<boolean> {
  const on = await readFliptBoolean(FLIPT_FEATURE_FLAGS.APP_BLOCKS_SHARED_DOC_LEVELS, appBlockId);
  return on ?? true;
}

/**
 * Whether the flag READS on for the app: unreadable counts as off. For the rater only, which
 * spends a scan per document: a Flipt outage must not start rating every app. Never a read gate;
 * those use {@link isSharedDocLevelsOn}.
 */
export async function isSharedDocLevelsKnownOn(appBlockId: string): Promise<boolean> {
  return (
    (await readFliptBoolean(FLIPT_FEATURE_FLAGS.APP_BLOCKS_SHARED_DOC_LEVELS, appBlockId)) === true
  );
}

/**
 * A block-token reader's level: the token's domain ceiling intersected with the viewer's own
 * browsing level, failing closed to PG — the same resolution the gated-image read uses
 * (`resolveViewerBrowsingLevel`). Shared documents are other people's content, so no floor is
 * added for them.
 */
export function viewerDocLevel(
  claims: Pick<BlockTokenClaims, 'maxBrowsingLevel' | 'viewerBrowsingLevel'>
): number {
  return resolveViewerBrowsingLevel(claims);
}

/**
 * The cap on a reader's OWN rated documents: the token's domain ceiling alone (the color domain's
 * maturity), not the reader's personal setting, so their own R document shows on a red-capable
 * host and not on the SFW one. Blocked is never selectable; fails closed to PG, as
 * {@link viewerDocLevel} does.
 */
export function domainDocLevel(claims: Pick<BlockTokenClaims, 'maxBrowsingLevel'>): number {
  const max = claims.maxBrowsingLevel;
  if (typeof max !== 'number' || !Number.isFinite(max)) return publicBrowsingLevelsFlag;
  return onlySelectableLevels(max) || publicBrowsingLevelsFlag;
}

/**
 * A registry subscription's level, from the mature ratings its audience may read
 * (`registry-adapter/audience.ts`): PG and PG-13 for everyone (the site never hides those by
 * rating), R with `r`, X with `x`. XXX is never included: an audience records only `r` and `x`,
 * so it cannot say whether its user admits XXX, and the feed fails closed on it.
 */
export function audienceDocLevel(allowed: { r: boolean; x: boolean }): number {
  return (
    NsfwLevel.PG | NsfwLevel.PG13 | (allowed.r ? NsfwLevel.R : 0) | (allowed.x ? NsfwLevel.X : 0)
  );
}

/**
 * `access` as the store must run it for this block token: with the levels gate on its context
 * when the flag is on for the app whose documents it reaches (the import's source app through an
 * import), unchanged otherwise.
 */
export async function withDocLevelGate(
  access: StorageAccess,
  claims: Pick<BlockTokenClaims, 'maxBrowsingLevel' | 'viewerBrowsingLevel'>
): Promise<StorageAccess> {
  if (!(await isSharedDocLevelsOn(access.ctx.appId))) return access;
  const levels: DocLevelGate = {
    viewerLevel: viewerDocLevel(claims),
    domainLevel: domainDocLevel(claims),
  };
  return { ...access, ctx: { ...access.ctx, levels } };
}
