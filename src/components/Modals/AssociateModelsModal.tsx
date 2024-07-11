import { Badge, CloseButton, Stack, Text, Group, Card, Switch } from '@mantine/core';
import { AssociationType } from '@prisma/client';
import { AssociateModels } from '~/components/AssociatedModels/AssociateModels';
import { useToggleResourceRecommendationMutation } from '~/components/AssociatedModels/recommender.utils';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { trpc } from '~/utils/trpc';

const { openModal, Modal } = createContextModal<{
  fromId: number;
  type: AssociationType;
  versionId?: number;
}>({
  name: 'associateModels',
  withCloseButton: false,
  size: 600,
  Element: ({ context, props: { fromId, type, versionId } }) => {
    const { data } = trpc.model.getById.useQuery({ id: fromId });
    const { toggleResourceRecommendation, isLoading } = useToggleResourceRecommendationMutation();

    const selectedVersion = data?.modelVersions.find((v) => v.id === versionId);

    const handleToggleAIRecommendations = async () => {
      if (!versionId) return;
      await toggleResourceRecommendation({ resourceId: versionId }).catch(() => null);
    };

    return (
      <Stack>
        <Group noWrap position="apart">
          <Text>{`Manage ${type} Resources`}</Text>
          <CloseButton onClick={context.close} />
        </Group>
        <Card withBorder>
          <Group spacing={8} position="apart" noWrap>
            <Stack spacing={0}>
              <Group spacing={8} noWrap>
                <Text weight={600}>Include AI recommendations</Text>
                <Badge radius="xl" size="sm" color="yellow">
                  Beta
                </Badge>
              </Group>
              <Text size="sm" color="dimmed">
                Use Civitai AI to recommended resources related to your creation
              </Text>
            </Stack>
            <Switch
              onChange={handleToggleAIRecommendations}
              defaultChecked={selectedVersion?.meta.allowAIRecommendations}
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
