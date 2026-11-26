import { imageStore } from '~/store/image.store';
import { showErrorNotification } from '~/utils/notifications';

/** The badge's `image.moderate` callbacks: the image is marked moderated only once the moderation
 *  lands, and a refusal (an image withheld from this moderator) is shown rather than dropped. */
export const needsReviewModeration = (imageId: number, notify = showErrorNotification) => ({
  onSuccess: () => imageStore.setImage(imageId, { needsReview: null, ingestion: 'Scanned' }),
  onError: (error: { message: string }) =>
    notify({ title: 'Image not moderated', error: new Error(error.message) }),
});
