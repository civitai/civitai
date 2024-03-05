import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { EditResourceReview } from '~/components/ResourceReview/EditResourceReview';
import { ResourceReviewPagedModel } from '~/types/router';

const { openModal, Modal } = createContextModal<
  Pick<ResourceReviewPagedModel, 'id' | 'modelId' | 'modelVersionId' | 'recommended' | 'details'>
>({
  name: 'resourceReviewEdit',
  title: 'Edit Review',
  size: 600,
  Element: ({ context, props: { id, details, recommended, modelId, modelVersionId } }) => {
    return (
      <EditResourceReview
        id={id}
        recommended={recommended}
        details={details}
        modelId={modelId}
        modelVersionId={modelVersionId}
        onSuccess={context.close}
        onCancel={context.close}
        initialEditing
      />
    );
  },
});

export const openResourceReviewEditModal = openModal;
export default Modal;
