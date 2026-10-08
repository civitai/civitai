import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { updateCollectionsNsfwLevels } from '~/server/services/nsfwLevels.service';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { isVisibleCollection } from '~/server/services/text-scan/collection-visibility';
import { notifyTextScanRatingRaised } from '~/server/services/text-scan/notify';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

type CollectionShape = {
  name: string;
  description: string | null;
  read: string;
  availability: string;
};

// Drives the save-time nsfwLevel recompute: the recompute skips hidden collections.
export const collectionBecameVisible = (before: CollectionShape, after: CollectionShape) =>
  !isVisibleCollection(before) && isVisibleCollection(after);

// Becoming visible rescans unchanged text: a stored verdict reads as `unchanged`, and one the
// profile never saw is scanned for the first time.
export function shouldScanCollection(before: CollectionShape | null, after: CollectionShape) {
  if (!isVisibleCollection(after)) return false;
  if (!before || !isVisibleCollection(before)) return true;
  return before.name !== after.name || (before.description ?? '') !== (after.description ?? '');
}

const read = (id: number) =>
  dbWrite.collection.findUnique({
    where: { id },
    select: { nsfwLevel: true, moderatorNsfwLevel: true, userId: true, name: true },
  });

export async function applyCollectionTextScan({
  entityId,
  workflowId,
  outcome,
}: ApplyTextScanArgs) {
  if (!outcome.nsfw) return;
  const before = await read(entityId);
  if (!before) return;
  await updateCollectionsNsfwLevels([entityId]);
  if (
    !outcome.nsfw.raised ||
    outcome.nsfw.detectedLevel < NsfwLevel.R ||
    before.moderatorNsfwLevel != null
  )
    return;
  const after = await read(entityId);
  const rose =
    !!after &&
    !(before.nsfwLevel & nsfwBrowsingLevelsFlag) &&
    !!(after.nsfwLevel & nsfwBrowsingLevelsFlag);
  if (!rose) return;
  await notifyTextScanRatingRaised({
    entityType: 'Collection',
    entityId,
    userId: before.userId,
    level: NsfwLevel.R,
    title: before.name,
    url: `/collections/${entityId}`,
    workflowId,
  });
}
