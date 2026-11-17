import type { DB } from '@civitai/db-schema/kysely';
import type { Selectable } from 'kysely';
import { isRestrictedImage } from '~/shared/utils/restricted-image';

/**
 * An image (an article cover or banner, a profile cover) as anyone but its owner and moderators
 * may see it: only once it is scanned, rated and not awaiting review, and never a mature image made
 * with a restricted base model.
 */
export function servableArticleImage<
  T extends Pick<
    Selectable<DB['Image']>,
    'ingestion' | 'needsReview' | 'nsfwLevel' | 'modelRestricted'
  >
>(image: T | null | undefined): T | null {
  return image &&
    image.ingestion === 'Scanned' &&
    image.nsfwLevel !== 0 &&
    !image.needsReview &&
    !isRestrictedImage(image)
    ? image
    : null;
}
