import { CloseButton, Stack, Text, Group, Card, Switch } from '@mantine/core';
import { AssociationType } from '@prisma/client';
import { AssociateModels } from '~/components/AssociatedModels/AssociateModels';
import { useToggleResourceRecommendationMutation } from '~/components/AssociatedModels/recommender.utils';
import { createContextModal } from '~/components/Modals/utils/createContextModal';

const { openModal, Modal } = createContextModal<{
  fromId: number;
  type: AssociationType;
}>({
  name: 'associateModels',
  withCloseButton: false,
  size: 600,
  Element: ({ context, props: { fromId, type } }) => {
    const { toggleResourceRecommendation, isLoading } = useToggleResourceRecommendationMutation();

    return (
      <Stack>
        <Group noWrap position="apart">
          <Text>{`Manage ${type} Resources`}</Text>
          <CloseButton onClick={context.close} />
        </Group>
        <Card withBorder>
          <Group spacing={8} position="apart" noWrap>
            <Stack spacing={0}>
              <Text weight={600}>Include AI recommendations</Text>
              <Text size="sm" color="dimmed">
                Use Civitai AI to recommended resources related to your creation
              </Text>
            </Stack>
            <Switch
              onChange={() => toggleResourceRecommendation({ resourceId: fromId })}
              disabled={isLoading}
            />
          </Group>
        </Card>
        <AssociateModels fromId={fromId} type={type} onSave={context.close} />
      </Stack>
    );
  },
});

export const openAssociateModelsModal = openModal;
export default Modal;
