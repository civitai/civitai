import {
  closestCenter,
  DndContext,
  DragEndEvent,
  PointerSensor,
  UniqueIdentifier,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Button, Card, Center, Group, Loader, Modal, Stack, Text, Title } from '@mantine/core';
import { IconGripVertical } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import { useState } from 'react';

import { SortableItem } from '~/components/ImageUpload/SortableItem';
import { ModelGetVersions } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function ReorderVersionsModal({ modelId, opened, onClose }: Props) {
  const queryUtils = trpc.useContext();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const [versions, setVersions] = useState<ModelGetVersions>([]);

  const { data, isLoading } = trpc.model.getVersions.useQuery(
    { id: modelId },
    {
      enabled: opened,
      onSuccess: (result) => setVersions(result),
    }
  );

  const reorderMutation = trpc.model.reorderVersions.useMutation({
    async onMutate(payload) {
      await queryUtils.model.getVersions.cancel();
      await queryUtils.model.getById.cancel({ id: payload.id });

      const previousData = queryUtils.model.getById.getData({ id: payload.id });

      if (previousData) {
        // reorder previousData modelVersions based on the payload versions index
        const sorted = payload.modelVersions.map((v) => {
          const index = previousData.modelVersions.findIndex((m) => m.id === v.id);
          return previousData.modelVersions[index];
        });

        queryUtils.model.getById.setData(
          { id: payload.id },
          { ...previousData, modelVersions: sorted }
        );
      }

      return { previousData };
    },
    async onSuccess() {
      await queryUtils.model.getVersions.invalidate({ id: modelId });
    },
    onError(error, payload, context) {
      if (context) queryUtils.model.getById.setData({ id: payload.id }, context.previousData);
      showErrorNotification({ error: new Error(error.message), title: 'Failed to save' });
    },
  });
  const handleSave = () => {
    if (!isEqual(data, versions)) {
      reorderMutation.mutate({ id: modelId, modelVersions: versions });
    }

    onClose();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      setVersions((items) => {
        const ids = items.map(({ id }): UniqueIdentifier => id);
        const oldIndex = ids.indexOf(active.id);
        const newIndex = ids.indexOf(over.id);
        const sorted = arrayMove(items, oldIndex, newIndex);
        return sorted;
      });
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Stack spacing={0}>
          <Title order={3}>Rearrange versions</Title>
          <Text size="sm" color="dimmed">
            Drag and drop the versions to set their order
          </Text>
        </Stack>
      }
      styles={{ header: { alignItems: 'flex-start' } }}
      centered
    >
      {isLoading ? (
        <Center>
          <Loader size="lg" />
        </Center>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={versions.map((v) => v.id)} strategy={verticalListSortingStrategy}>
            <Stack>
              {versions.map((version) => (
                <SortableItem key={version.id} id={version.id}>
                  <Card withBorder>
                    <Group align="start">
                      <IconGripVertical />
                      <Text size="md" lineClamp={2}>
                        {version.name}
                      </Text>
                    </Group>
                  </Card>
                </SortableItem>
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      )}
      <Group position="right" mt="xl">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={isLoading} loading={reorderMutation.isLoading}>
          Save
        </Button>
      </Group>
    </Modal>
  );
}

type Props = {
  opened: boolean;
  onClose: VoidFunction;
  modelId: number;
};
