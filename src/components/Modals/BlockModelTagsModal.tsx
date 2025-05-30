import { Button, Center, Chip, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useHiddenPreferencesData, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';
import { trpc } from '~/utils/trpc';

export default function BlockedModelTagsModal({ modelId }: { modelId: number }) {
  const dialog = useDialogContext();

  const tags = useHiddenPreferencesData().hiddenTags;
  const allHiddenTags = useMemo(() => tags.filter((x) => x.hidden), [tags]);
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
    dialog.onClose();
  };

  return (
    <Modal {...dialog} title="Hide Tags">
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
              <Chip.Group value={selectedTags} onChange={setSelectedTags} multiple>
                <Group gap={4} justify="center">
                  {modelTags.map((tag) => {
                    const selected = selectedTags.includes(String(tag.id));

                    return (
                      <Chip
                        key={tag.id}
                        color={selected ? 'red' : undefined}
                        radius="xs"
                        value={String(tag.id)}
                      >
                        <span>{tag.name}</span>
                      </Chip>
                    );
                  })}
                </Group>
              </Chip.Group>
              <Group justify="space-between">
                <Button variant="default" onClick={dialog.onClose}>
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
              <Group justify="end">
                <Button variant="default" onClick={dialog.onClose}>
                  Close
                </Button>
              </Group>
            </>
          )}
        </Stack>
      )}
    </Modal>
  );
}
