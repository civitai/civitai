import { logToAxiom } from '~/server/logging/client';

const logLoadError = (error: unknown, meta: Record<string, string>) =>
  logToAxiom({
    type: 'error',
    name: 'profile-picture-cache-refresh',
    message: (error as Error)?.message,
    ...meta,
  });

/**
 * `refreshProfilePicturesForImages`, behind a dynamic import of user.service, so report.service,
 * tagsOnImageNew.service and the adjust-tag-level handler load user.service (most of the server)
 * only when called. Not a cycle cut: the cycle guards count dynamic imports
 * (docs/dev/import-cycles.md).
 *
 * Never throws, like the helper itself: every caller follows a committed write. The helper logs its
 * own failures; a failure to load the module is logged here under the same name.
 */
export const refreshProfilePicturesForImagesLazy = (imageIds: number[]) =>
  import('~/server/services/user.service')
    .then(({ refreshProfilePicturesForImages }) => refreshProfilePicturesForImages(imageIds))
    .catch((error) => logLoadError(error, { imageIds: imageIds.join(',') }));

/** `refreshProfilePicturesForUsers` behind the same dynamic import, for jobs. Never throws. */
export const refreshProfilePicturesForUsersLazy = (userIds: number[]) =>
  import('~/server/services/user.service')
    .then(({ refreshProfilePicturesForUsers }) => refreshProfilePicturesForUsers(userIds))
    .catch((error) => logLoadError(error, { userIds: userIds.join(',') }));
