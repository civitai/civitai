import { handleLogError } from '~/server/utils/errorHandling';

/**
 * `bustCachesForPosts` behind a dynamic import of post.service, which loads most of the server, for
 * the scan-result handlers. Never throws: every caller follows a committed write.
 */
export const bustPostCachesLazy = (postId: number) =>
  import('~/server/services/post.service')
    .then(({ bustCachesForPosts }) => bustCachesForPosts(postId))
    .catch((error) => handleLogError(error as Error));
