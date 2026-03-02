import { Button, Loader, NavLink, ScrollArea, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { CreateJudgeModal } from './CreateJudgeModal';
import { usePlaygroundStore } from './playground.store';

export function JudgeListPanel() {
  const { data: judges, isLoading } = trpc.challenge.getJudges.useQuery();
  const selectedJudgeId = usePlaygroundStore((s) => s.selectedJudgeId);
  const setSelectedJudgeId = usePlaygroundStore((s) => s.setSelectedJudgeId);
  const drafts = usePlaygroundStore((s) => s.drafts);

  const [modalOpened, { open: openModal, close: closeModal }] = useDisclosure(false);

  if (isLoading) {
    return (
      <Stack align="center" py="xl">
        <Loader size="sm" />
      </Stack>
    );
  }

  return (
    <>
      <Stack gap={0} h="100%">
        <Text fw={600} size="sm" p="sm" pb="xs">
          Judges
        </Text>
        <ScrollArea flex={1}>
          <Stack gap={2} px="xs">
            {judges?.map((judge) => {
              const hasDraft = drafts[judge.id] && Object.keys(drafts[judge.id]).length > 0;
              return (
                <NavLink
                  key={judge.id}
                  label={
                    <Text size="sm">
                      {hasDraft && (
                        <Text component="span" c="yellow" mr={4}>
                          &bull;
                        </Text>
                      )}
                      {judge.name}
                    </Text>
                  }
                  description={judge.bio ? judge.bio.slice(0, 50) : undefined}
                  active={selectedJudgeId === judge.id}
                  onClick={() => setSelectedJudgeId(judge.id)}
                  variant="light"
                  styles={{ root: { borderRadius: 'var(--mantine-radius-sm)' } }}
                />
              );
            })}
          </Stack>
        </ScrollArea>
        <Button
          variant="light"
          leftSection={<IconPlus size={14} />}
          size="xs"
          m="sm"
          onClick={openModal}
        >
          Add Judge
        </Button>
      </Stack>
      <CreateJudgeModal opened={modalOpened} onClose={closeModal} />
    </>
  );
}
