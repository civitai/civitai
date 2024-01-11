export const getImageEntityUrl = (image: {
  id: number;
  entityId?: number | null;
  entityType?: string | null;
  postId?: number | null;
  metadata?: { profilePicture?: boolean; username?: number } | null;
}) => {
  // if (image.postId) return `/posts/${image.postId}`;
  if (image.metadata?.username) return `/user/${image.metadata.username}`;

  switch (image.entityType) {
    case 'Bounty':
      return `/bounties/${image.entityId}`;
    case 'BountyEntry':
      return `/bounties/entries/${image.entityId}`;
    default:
      return `/images/${image.id}`;
  }
};
