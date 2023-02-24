import { Button, Center, Chip, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { createRoutedContext } from '~/routed-context/create-routed-context';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default createRoutedContext({
  authGuard: true,
  schema: z.object({
    modelId: z.number(),
  }),
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

    return (
      <Modal opened={context.opened} onClose={context.close} title="Hide Tags">
        {isLoading ? (
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
                      <Chip
                        key={tag.id}
                        color={selected ? 'red' : undefined}
                        value={String(tag.id)}
                      >
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
        )}
      </Modal>
    );
  },
});
