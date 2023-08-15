import { Button, Center, Chip, Group, Loader, Stack, Text } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { useHiddenPreferences, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';
import { trpc } from '~/utils/trpc';

const { openModal, Modal } = createContextModal<{ modelId: number }>({
  name: 'blockModelTags',
  title: 'Hide Tags',
  Element: ({ context, props: { modelId } }) => {
    const tags = useHiddenPreferences().tag;
    const allHiddenTags = useMemo(() => tags.filter((x) => x.type === 'hidden'), [tags]);
    const { data, isLoading } = trpc.tag.getAll.useQuery({
      limit: 200,
      entityType: ['Model'],
      modelId,
    });
    const modelTags = useMemo(() => data?.items ?? [], [data?.items]);
    const blockedTags = useMemo(
      () => modelTags.filter((x) => allHiddenTags.some((y) => y.id === x.id)),
      [modelTags, allHiddenTags]
    );
    const [selectedTags, setSelectedTags] = useState<string[]>([]);

    useEffect(() => {
      if (blockedTags.length) setSelectedTags(blockedTags.map((x) => String(x.id)));
    }, [blockedTags]);

    const toggleHiddenMutation = useToggleHiddenPreferences();

    // const handleBlockTags = () => mutate({ tagIds: selectedTags.map(Number) });
    const handleBlockTags = async () => {
      const selectedTagIds = selectedTags.map(Number);
      const tags = modelTags
        .filter((x) => selectedTagIds.includes(x.id))
        .map(({ id, name }) => ({ id, name }));
      await toggleHiddenMutation.mutateAsync({ kind: 'tag', data: tags, hidden: true });
      context.close();
    };

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
                  <Chip
                    key={tag.id}
                    color={selected ? 'red' : undefined}
                    radius="xs"
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
              <Button onClick={handleBlockTags} loading={toggleHiddenMutation.isLoading}>
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
