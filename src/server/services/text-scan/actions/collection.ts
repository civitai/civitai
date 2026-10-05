import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { updateCollectionsNsfwLevels } from '~/server/services/nsfwLevels.service';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { notifyTextScanRatingRaised } from '~/server/services/text-scan/notify';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

type CollectionShape = {
  name: string;
  description: string | null;
  read: string;
  availability: string;
};

const visible = (c: CollectionShape) =>
  c.availability === 'Public' && (c.read === 'Public' || c.read === 'Unlisted');

// Becoming visible rescans unchanged text: a stored verdict reads as `unchanged`, and one the
// profile never saw is scanned for the first time.
export const collectionBecameVisible = (before: CollectionShape, after: CollectionShape) =>
  !visible(before) && visible(after);

export function shouldScanCollection(before: CollectionShape | null, after: CollectionShape) {
  if (!visible(after)) return false;
  if (!before || !visible(before)) return true;
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
