/**
 * CONTENT LEVELS of App Blocks shared documents: where the flag is read and where each reader's
 * level comes from. The SQL predicate itself is `sharedDocLevelVisible` in `doc-store.ts`, its one
 * definition; this module only decides WHETHER the store applies it and WITH WHICH LEVEL.
 *
 * - The flag: `app-blocks-shared-doc-levels`, evaluated per app (entity id = the app block id
 *   whose documents are read or written, NO context), like the shared-data moderation flags. Off,
 *   the store's context carries no `levels` and every statement is the one it ran before.
 * - A block-token reader (the storage REST routes): the token's viewer level
 *   ({@link viewerDocLevel}).
 * - The registry feed: the subscription's audience ({@link audienceDocLevel}).
 * - The server key lookup (App Store item cards, spend attribution): no reader identity, so every
 *   browsable level ({@link SERVER_LOOKUP_DOC_LEVEL}): only the rating status gates it.
 *
 * Levels are the site's NsfwLevel bits and a viewer level is a bitwise set of them; a document is
 * within it when its one level bit is in the set (the site's bitwise browsing-level semantics).
 */
import { NsfwLevel } from '~/server/common/enums';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import type { StorageAccess } from '~/server/services/apps/doc-store-access';
import type { DocLevelGate } from '~/server/services/apps/doc-store.types';
import { resolveViewerBrowsingLevel } from '~/server/services/blocks/block-viewer-ceiling';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/** Whether content levels are on for the app whose shared documents are being read or written. */
export function isSharedDocLevelsOn(appBlockId: string): Promise<boolean> {
  return isFlipt(FLIPT_FEATURE_FLAGS.APP_BLOCKS_SHARED_DOC_LEVELS, appBlockId);
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
 * The server key lookup's level: every browsable level (`Blocked` excluded). The lookup has no
 * reader, and what reads it renders with its own per-viewer maturity, so only the rating status
 * (and a Blocked level) leave a document out.
 */
export const SERVER_LOOKUP_DOC_LEVEL: number = allBrowsingLevelsFlag;

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
  const levels: DocLevelGate = { viewerLevel: viewerDocLevel(claims) };
  return { ...access, ctx: { ...access.ctx, levels } };
}

/** The lookup's gate for an app, or undefined while its flag is off. */
export async function lookupDocLevelGate(appBlockId: string): Promise<DocLevelGate | undefined> {
  return (await isSharedDocLevelsOn(appBlockId))
    ? { viewerLevel: SERVER_LOOKUP_DOC_LEVEL }
    : undefined;
}
