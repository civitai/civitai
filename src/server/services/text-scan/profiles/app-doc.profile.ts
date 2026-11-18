import { loadAppDocSubjects } from '~/server/services/apps/doc-rater-subject';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';

/**
 * An App Blocks shared document (content levels, `doc-rater.service.ts`): every string value and
 * object key of its `data`, keyed by the document's rating id. Rated for `nsfw` only: the level is
 * the whole point, and it is the higher of this verdict and the document's images.
 */
registerTextScanProfile({
  entityType: 'AppDoc',
  labels: ['nsfw'],
  load: loadAppDocSubjects,
});
