import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { EditResourceReview } from '~/components/ResourceReview/EditResourceReview';
import { ResourceReviewPagedModel } from '~/types/router';

const { openModal, Modal } = createContextModal<
  ResourceReviewPagedModel & { details?: string; modelVersionId: number }
>({
  name: 'resourceReviewEdit',
  title: 'Edit Review',
  size: 600,
  Element: ({ context, props: { id, rating, details, recommended, modelId, modelVersionId } }) => {
    return (
      <EditResourceReview
        id={id}
        rating={rating}
        recommended={recommended}
        details={details}
        modelId={modelId}
        modelVersionId={modelVersionId}
        onSuccess={context.close}
        onCancel={context.close}
        initialEditing
        // // TODO.review: use correct value
        // thumbsUpCount={resource.modelRatingCount ?? 0}
      />
    );
  },
});

export const openResourceReviewEditModal = openModal;
export default Modal;
