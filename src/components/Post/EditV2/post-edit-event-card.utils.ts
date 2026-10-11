/**
 * Whether the post editor offers the event card, and on what. Only the post's owner can hat its
 * images (the equip refuses anyone else, moderators included), and a contest entry's sidebar
 * already carries the contest's own callout.
 */
export function postEditEventCard<TImage extends { id: number }>({
  ownerId,
  viewerId,
  collectionId,
  publishedAt,
  unpublishedByParent,
  addedImages,
  now = new Date(),
}: {
  ownerId?: number;
  viewerId?: number;
  collectionId?: number | null;
  publishedAt?: Date | null;
  unpublishedByParent: boolean;
  addedImages: TImage[];
  now?: Date;
}) {
  if (!viewerId || ownerId !== viewerId || collectionId) return undefined;
  const live = !!publishedAt && publishedAt.getTime() <= now.getTime();
  return {
    coverImage: addedImages[0] as TImage | undefined,
    // A scheduled post earns nothing until it goes live; one held by its parent cannot be published here.
    showDraftNote: !live && !unpublishedByParent,
  };
}
