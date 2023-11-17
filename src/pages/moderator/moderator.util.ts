export const getImageEntityUrl = (image: {
  id: number;
  entityId?: number;
  entityType?: string;
  postId?: number;
}) => {
  if (image.postId) {
    return `/posts/${image.postId}`;
  }
  switch (image.entityType) {
    case 'Bounty':
      return `/bounties/${image.entityId}`;
    case 'BountyEntry':
      return `/bounties/entries/${image.entityId}`;
    default:
      return `/images/${image.id}`;
  }
};
