import { Button, Center, Chip, Group, Loader, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { createContextModal } from '~/components/Modals/utils/createContextModal';

import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const { openModal, Modal } = createContextModal<{ modelId: number }>({
  name: 'blockModelTags',
  title: 'Hide Tags',
  Element: ({ context, props: { modelId } }) => {
    const queryUtils = trpc.useContext();

    const { data: blockedTags = [] } = trpc.user.getTags.useQuery({ type: 'Hide' });
    const { data, isLoading } = trpc.tag.getAll.useQuery({
      limit: 0,
      entityType: ['Model'],
      modelId,
    });
    const modelTags = data?.items ?? [];
    const [selectedTags, setSelectedTags] = useState<string[]>([]);

    useEffect(() => {
      if (blockedTags.length) setSelectedTags(blockedTags.map(({ id }) => String(id)));
    }, [blockedTags]);

    const { mutate, isLoading: mutatingBlockedTags } = trpc.user.batchBlockTags.useMutation({
      async onSuccess() {
        context.close();

        await queryUtils.model.getAll.invalidate();
        await queryUtils.user.getTags.invalidate({ type: 'Hide' });
      },
      onError(error) {
        showErrorNotification({ error: new Error(error.message) });
      },
    });

    const handleBlockTags = () => mutate({ tagIds: selectedTags.map(Number) });

    return isLoading ? (
      <Center p="lg">
        <Loader size="lg" />
      </Center>
    ) : (
      <Stack>
        {modelTags.length > 0 ? (
          <>
            <Text size="sm" color="dimmed">
              Select the tags you want to add to your blocking list
            </Text>
            <Chip.Group
              spacing={4}
              position="center"
              value={selectedTags}
              onChange={setSelectedTags}
              multiple
            >
              {modelTags.map((tag) => {
                const selected = selectedTags.includes(String(tag.id));

                return (
                  <Chip key={tag.id} color={selected ? 'red' : undefined} value={String(tag.id)}>
                    {tag.name}
                  </Chip>
                );
              })}
            </Chip.Group>
            <Group position="apart">
              <Button variant="default" onClick={context.close}>
                Cancel
              </Button>
              <Button onClick={handleBlockTags} loading={mutatingBlockedTags}>
                Save
              </Button>
            </Group>
          </>
        ) : (
          <>
            <Text>{`This model doesn't have any tags`}</Text>
            <Group position="right">
              <Button variant="default" onClick={context.close}>
                Close
              </Button>
            </Group>
          </>
        )}
      </Stack>
    );
  },
});

export const openBlockModelTagsModal = openModal;
export default Modal;
