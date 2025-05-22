import { Badge, CloseButton, Stack, Text, Group, Card, Switch } from '@mantine/core';
import { AssociationType } from '~/shared/utils/prisma/enums';
import { AssociateModels } from '~/components/AssociatedModels/AssociateModels';
import { useToggleResourceRecommendationMutation } from '~/components/AssociatedModels/recommender.utils';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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
    const features = useFeatureFlags();
    const { data } = trpc.model.getById.useQuery({ id: fromId });
    const { toggleResourceRecommendation, isLoading } = useToggleResourceRecommendationMutation();

    const selectedVersion = data?.modelVersions.find((v) => v.id === versionId);

    const handleToggleAIRecommendations = async () => {
      if (!versionId || !features.recommenders) return;
      await toggleResourceRecommendation({ resourceId: versionId }).catch(() => null);
    };

    return (
      <Stack>
        <Group wrap="nowrap" justify="space-between">
          <Text>{`Manage ${type} Resources`}</Text>
          <CloseButton onClick={context.close} />
        </Group>
        {features.recommenders && (
          <Card withBorder>
            <Group gap={8} justify="space-between" wrap="nowrap">
              <Stack gap={0}>
                <Group gap={8} wrap="nowrap">
                  <Text fw={600}>Include AI recommendations</Text>
                  <Badge radius="xl" size="sm" color="yellow">
                    Beta
                  </Badge>
                </Group>
                <Text size="sm" c="dimmed">
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
        )}
        <AssociateModels fromId={fromId} type={type} onSave={context.close} />
      </Stack>
    );
  },
});

export const openAssociateModelsModal = openModal;
export default Modal;
