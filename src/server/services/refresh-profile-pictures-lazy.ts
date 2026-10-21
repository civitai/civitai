import { logToAxiom } from '~/server/logging/client';

/**
 * `refreshProfilePicturesForImages`, behind a dynamic import of user.service, for the callers a
 * static import would hurt: report.service and tagsOnImageNew.service (user.service imports
 * image.service, which closes the import cycle) and the adjust-tag-level handler (user.service pulls
 * in most of the server).
 *
 * Never throws, like the helper itself: every caller follows a committed write. The helper logs its
 * own failures; a failure to load the module is logged here under the same name.
 */
export const refreshProfilePicturesForImagesLazy = (imageIds: number[]) =>
  import('~/server/services/user.service')
    .then(({ refreshProfilePicturesForImages }) => refreshProfilePicturesForImages(imageIds))
    .catch((error) => {
      logToAxiom({
        type: 'error',
        name: 'profile-picture-cache-refresh',
        message: (error as Error)?.message,
        imageIds: imageIds.join(','),
      }).catch(() => undefined);
    });
