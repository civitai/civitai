/**
 * What saving an item into collections credits: the collector reward (on an add) and the image's
 * Collection metric (+1 on an add, -1 on a removal). Nothing when the save does not earn credit,
 * as filing your own work into your own folder does not (`earnsCollectCredit`).
 */
export function saveItemCredit({
  credited,
  status,
  type,
  entityId,
  imageId,
}: {
  credited: boolean;
  status: string | null;
  type?: string | null;
  entityId?: number;
  imageId?: number | null;
}) {
  if (!credited) return { rewardEntityId: undefined, imageMetric: undefined };
  return {
    rewardEntityId: status === 'added' && type ? entityId : undefined,
    imageMetric: type === 'Image' && imageId ? (status === 'added' ? 1 : -1) : undefined,
  };
}
