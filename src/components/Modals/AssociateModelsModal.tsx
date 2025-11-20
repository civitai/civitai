import { Badge, CloseButton, Stack, Text, Group, Card, Switch, Modal } from '@mantine/core';
import type { AssociationType } from '~/shared/utils/prisma/enums';
import { AssociateModels } from '~/components/AssociatedModels/AssociateModels';
import { useToggleResourceRecommendationMutation } from '~/components/AssociatedModels/recommender.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';
import { useDialogContext } from '~/components/Dialog/DialogContext';

export default function AssociateModelsModal({
  fromId,
  type,
  versionId,
}: {
  fromId: number;
  type: AssociationType;
  versionId?: number;
}) {
  const dialog = useDialogContext();
  const features = useFeatureFlags();
  const { data } = trpc.model.getById.useQuery({ id: fromId });
  const { toggleResourceRecommendation, isLoading } = useToggleResourceRecommendationMutation();

  const selectedVersion = data?.modelVersions.find((v) => v.id === versionId);

  const handleToggleAIRecommendations = async () => {
    if (!versionId || !features.recommenders) return;
    await toggleResourceRecommendation({ resourceId: versionId }).catch(() => null);
  };

  return (
    <Modal {...dialog} withCloseButton={false}>
      <Stack>
        <Group wrap="nowrap" justify="space-between">
          <Text>{`Manage ${type} Resources`}</Text>
          <CloseButton onClick={dialog.onClose} />
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
                defaultChecked={selectedVersion?.meta?.allowAIRecommendations ?? false}
                disabled={isLoading}
              />
            </Group>
          </Card>
        )}
        <AssociateModels fromId={fromId} type={type} onSave={dialog.onClose} />
      </Stack>
    </Modal>
  );
}
