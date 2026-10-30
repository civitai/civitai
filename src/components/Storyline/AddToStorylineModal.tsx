import { Alert, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { StorylineThumb } from '~/components/Storyline/StorylineThumb';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import type { StorylineSourcePost } from '~/components/Storyline/storyline.utils';
import { getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import { storylineLevelAllowed } from '~/shared/utils/storyline';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function openAddToStorylineModal(post: StorylineSourcePost) {
  dialogStore.trigger({ component: AddToStorylineModal, props: { post } });
}

/**
 * Adds a published post to one of the viewer's own storylines: chapter 1 of an empty one, else the
 * next chapter after the end of its main path, by the same rules as adding it from the storyline.
 */
export function AddToStorylineModal({ post }: { post: StorylineSourcePost }) {
  const dialog = useDialogContext();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [storylineId, setStorylineId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const { data, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    trpc.storyline.getInfinite.useInfiniteQuery(
      { filter: 'mine', limit: 20 },
      { getNextPageParam: (last) => last.nextCursor }
    );
  const storylines = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const addAtEnd = trpc.storyline.addChapterAtEnd.useMutation();

  // Chapter 1 raises an empty storyline's maximum to fit it, so only a later chapter is held to it.
  const refusal = (storyline: (typeof storylines)[number]) =>
    storyline.status === 'Complete'
      ? 'Complete'
      : storyline.chapterCount > 0 &&
        !storylineLevelAllowed({ postLevel: post.nsfwLevel, maxNsfwLevel: storyline.maxNsfwLevel })
      ? `Allows up to ${getBrowsingLevelLabel(storyline.maxNsfwLevel)}`
      : null;
  const picked = storylines.find((storyline) => storyline.id === storylineId);

  const add = async () => {
    if (!picked) return;
    setError(null);
    setAdding(true);
    try {
      await addAtEnd.mutateAsync({ storylineId: picked.id, postId: post.id });
      await utils.storyline.invalidate();
      showSuccessNotification({ message: `Added to ${picked.title}.` });
      dialog.onClose();
      await router.push(storylineUrl(picked.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Modal {...dialog} title="Add to a storyline" size="md">
      {isLoading ? (
        <Group justify="center" p="xl">
          <Loader />
        </Group>
      ) : isError ? (
        <Alert color="red">Couldn&apos;t load your storylines.</Alert>
      ) : !storylines.length ? (
        <Text size="sm" c="dimmed">
          You have no storylines yet. Use &quot;Make this chapter 1 of a storyline&quot; to start
          one from this post.
        </Text>
      ) : (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            It joins as the next chapter after the end of the main path, or as chapter 1 of an empty
            storyline.
          </Text>
          <div
            role="radiogroup"
            aria-label="Your storylines"
            className="-m-1 flex max-h-[55vh] flex-col gap-1 overflow-y-auto p-1"
          >
            {storylines.map((storyline) => {
              const refused = refusal(storyline);
              const selected = storyline.id === storylineId;
              return (
                <button
                  key={storyline.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!!refused}
                  onClick={() => setStorylineId(storyline.id)}
                  className={clsx(
                    'flex items-center gap-3 rounded-lg p-2 text-left outline-none',
                    'focus-visible:ring-2 focus-visible:ring-blue-5/50 disabled:opacity-50',
                    selected && 'ring-2 ring-blue-5'
                  )}
                >
                  <StorylineThumb image={storyline.coverImage} width={40} className="shrink-0" />
                  <div className="min-w-0 flex-1">
                    <Text size="sm" fw={600} lineClamp={1}>
                      {storyline.title}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {refused ??
                        (storyline.chapterCount === 0
                          ? 'No chapters yet: this post becomes chapter 1'
                          : `${storyline.chapterCount} ${
                              storyline.chapterCount === 1 ? 'chapter' : 'chapters'
                            }`)}
                    </Text>
                  </div>
                  {selected && <IconCheck size={16} className="shrink-0 text-blue-6" />}
                </button>
              );
            })}
          </div>
          {hasNextPage && (
            <Button
              variant="default"
              size="xs"
              className="self-center"
              loading={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              Show more
            </Button>
          )}
          {error && (
            <Alert color="red">
              <Text size="sm">{error}</Text>
            </Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={dialog.onClose}>
              Cancel
            </Button>
            <Button disabled={!picked} loading={adding} onClick={add}>
              Add chapter
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
