import { Alert, Button, Loader, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconGitMerge } from '@tabler/icons-react';
import clsx from 'clsx';
import { useId, useState } from 'react';
import { StorylineThumb } from '~/components/Storyline/StorylineThumb';
import { getStorylineChapterName } from '~/components/Storyline/storyline-mode.utils';
import { useLinkStorylineChapter } from '~/components/Storyline/storyline.data';
import { trpc } from '~/utils/trpc';

const TILE_WIDTH = 140;

/**
 * The owner offering a chapter already in their story as a way on from this one, so two branches
 * rejoin there. The server lists only the chapters it would accept.
 */
export function StorylineJoinChapterForm({
  parentChapterId,
  parentName,
  onClose,
}: {
  parentChapterId: number;
  parentName: string | null;
  onClose: () => void;
}) {
  const [chapterId, setChapterId] = useState<number | null>(null);
  // Kept by name: the list is read again after the link, and no longer has the chapter in it.
  const [joinedName, setJoinedName] = useState<string | null>(null);
  const pickerLabelId = useId();
  const {
    data: targets,
    isLoading,
    isError,
  } = trpc.storyline.getLinkTargets.useQuery({
    parentChapterId,
  });
  const target = targets?.find((candidate) => candidate.chapterId === chapterId);
  const targetName = target ? getStorylineChapterName(target) : null;
  const link = useLinkStorylineChapter({ onSuccess: () => setJoinedName(targetName) });
  const from = parentName ?? 'this chapter';

  if (joinedName)
    return (
      <Stack gap="md">
        <Alert color="green" icon={<IconCheck size={18} />} data-testid="storyline-join-done">
          Readers who finish {from} can now go on to {joinedName}.
        </Alert>
        <Button onClick={onClose}>Done</Button>
      </Stack>
    );

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        Bring two branches back together: offer a chapter already in your story as a way on from{' '}
        {from}. Nothing is copied.
      </Text>
      {isLoading ? (
        <Group justify="center" p="md">
          <Loader size="sm" />
        </Group>
      ) : isError ? (
        <Alert color="red">Couldn&apos;t load the chapters you can join.</Alert>
      ) : !targets?.length ? (
        <Text size="sm" c="dimmed" data-testid="storyline-join-empty">
          No chapter can be joined from here. The first chapter, chapters before this one, and links
          that would skip chapters are left out.
        </Text>
      ) : (
        <div
          role="radiogroup"
          aria-labelledby={pickerLabelId}
          className="-m-1 grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto p-1"
        >
          <span id={pickerLabelId} className="sr-only">
            Chapters you can join
          </span>
          {targets.map((candidate) => {
            const selected = candidate.chapterId === chapterId;
            const name = getStorylineChapterName(candidate);
            return (
              <button
                key={candidate.chapterId}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={name}
                onClick={() => setChapterId(candidate.chapterId)}
                className={clsx(
                  'flex min-w-0 flex-col gap-1 rounded-lg p-1 text-left outline-none',
                  'focus-visible:ring-2 focus-visible:ring-blue-5/50',
                  selected && 'ring-2 ring-blue-5 focus-visible:ring-blue-5'
                )}
                data-testid="storyline-join-target"
                data-chapter-id={candidate.chapterId}
              >
                <StorylineThumb image={candidate.firstImage} width={TILE_WIDTH} fluid />
                <Text size="xs" fw={600} lineClamp={2}>
                  {name}
                </Text>
                {candidate.post?.title && (
                  <Text size="xs" c="dimmed">
                    Chapter {candidate.depth + 1}
                  </Text>
                )}
              </button>
            );
          })}
        </div>
      )}

      {targetName && (
        <Text size="sm" data-testid="storyline-join-confirm">
          Readers who finish <strong>{from}</strong> will be offered <strong>{targetName}</strong>{' '}
          as a way on.
        </Text>
      )}
      {link.error && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          {link.error}
        </Alert>
      )}
      <Button
        leftSection={<IconGitMerge size={16} />}
        disabled={!chapterId}
        loading={link.isPending}
        onClick={() => chapterId && link.mutate({ parentChapterId, chapterId })}
        data-testid="storyline-join-submit"
      >
        Join this chapter
      </Button>
    </Stack>
  );
}
