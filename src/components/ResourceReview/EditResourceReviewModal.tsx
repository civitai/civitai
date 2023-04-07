import { Button, Group } from '@mantine/core';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { ResourceReviewForm } from '~/components/ResourceReview/ResourceReviewForm';
import { useUpdateResourceReview } from '~/components/ResourceReview/resourceReview.utils';

const { openModal, Modal } = createContextModal<{
  id: number;
  rating: number;
  details?: string;
  modelId: number;
  modelVersionId: number;
}>({
  name: 'resourceReviewEdit',
  title: 'Edit Review',
  size: 600,
  Element: ({ context, props: { id, rating, details, modelId, modelVersionId } }) => {
    const { mutate, isLoading } = useUpdateResourceReview({ modelId, modelVersionId });

    return (
      <ResourceReviewForm
        data={{ rating, details }}
        onSubmit={({ rating, details }) => {
          mutate(
            { id, rating, details },
            {
              onSuccess: () => {
                context.close();
              },
            }
          );
        }}
      >
        <Group position="apart">
          <Button onClick={context.close} variant="default">
            Cancel
          </Button>
          <Button type="submit" loading={isLoading}>
            Submit
          </Button>
        </Group>
      </ResourceReviewForm>
    );
  },
});

export const openResourceReviewEditModal = openModal;
export default Modal;
