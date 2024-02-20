import { Button, Group } from '@mantine/core';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { UserResourceReviewComposite } from '~/components/ResourceReview/EditUserResourceReview';
import { ResourceReviewForm } from '~/components/ResourceReview/ResourceReviewForm';
import { ResourceReviewThumbActions } from '~/components/ResourceReview/ResourceReviewThumbActions';
import { useUpdateResourceReview } from '~/components/ResourceReview/resourceReview.utils';
import { EditResourceReview } from '~/components/ResourceReview/EditResourceReview';
import { ResourceReviewPagedModel } from '~/types/router';

const { openModal, Modal } = createContextModal<
  ResourceReviewPagedModel & { details?: string; modelVersionId: number }
>({
  name: 'resourceReviewEdit',
  title: 'Edit Review',
  size: 600,
  Element: ({ context, props: { id, rating, details, recommended, modelId, modelVersionId } }) => {
    const { mutate, isLoading } = useUpdateResourceReview();

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
      // <UserResourceReviewComposite modelId={modelId} modelVersionId={modelVersionId}>
      //   {({ userReview }) => (
      //     <>
      //       <ResourceReviewThumbActions
      //         userReview={userReview}
      //         modelId={modelId}
      //         modelVersionId={modelVersionId}
      //       />

      //       <ResourceReviewForm
      //         data={{ rating, details }}
      //         onSubmit={({ rating, details }) => {
      //           mutate(
      //             { id, rating, details },
      //             {
      //               onSuccess: () => {
      //                 context.close();
      //               },
      //             }
      //           );
      //         }}
      //       >
      //         <Group position="apart">
      //           <Button onClick={context.close} variant="default">
      //             Cancel
      //           </Button>
      //           <Button type="submit" loading={isLoading}>
      //             Submit
      //           </Button>
      //         </Group>
      //       </ResourceReviewForm>
      //     </>
      //   )}
      // </UserResourceReviewComposite>
    );
  },
});

export const openResourceReviewEditModal = openModal;
export default Modal;
