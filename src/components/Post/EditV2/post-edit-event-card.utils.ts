/**
 * Whether the post editor offers the event card, and on what. Only the post's owner can hat its
 * images (the equip refuses anyone else, moderators included), and a contest entry's sidebar
 * already carries the contest's own callout. A post that belongs to a model hats the model.
 */
export function postEditEventCard<TImage extends { id: number }>({
  ownerId,
  viewerId,
  collectionId,
  publishedAt,
  unpublishedByParent,
  addedImages,
  parentModelId,
  now = new Date(),
}: {
  ownerId?: number;
  viewerId?: number;
  collectionId?: number | null;
  publishedAt?: Date | null;
  unpublishedByParent: boolean;
  addedImages: TImage[];
  parentModelId?: number | null;
  now?: Date;
}) {
  if (!viewerId || ownerId !== viewerId || collectionId) return undefined;
  const live = !!publishedAt && publishedAt.getTime() <= now.getTime();
  return {
    coverImage: addedImages[0] as TImage | undefined,
    modelId: parentModelId ?? undefined,
    // A scheduled post earns nothing until it goes live; one held by its parent cannot be published here.
    showDraftNote: !live && !unpublishedByParent,
  };
}
