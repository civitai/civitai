// A hidden user still sees their own posts, so the viewer is never in their own hidden set.
export function getEffectiveGalleryHiddenUserIds({
  modelHiddenUserIds = [],
  creatorHiddenUserIds = [],
  viewerId,
}: {
  modelHiddenUserIds?: number[];
  creatorHiddenUserIds?: number[];
  viewerId?: number;
}) {
  const ids = new Set([...modelHiddenUserIds, ...creatorHiddenUserIds]);
  if (viewerId !== undefined) ids.delete(viewerId);
  return [...ids];
}
