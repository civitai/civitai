import { Menu, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconTrash } from '@tabler/icons-react';
import { useRemoveStorylineChapter } from '~/components/Storyline/storyline.data';

/** Who is offered the removal; the server decides (a paid chapter, a pending continuation). */
export const canRemoveStorylineChapter = ({
  depth,
  authorId,
  ownerId,
  viewer,
}: {
  depth: number;
  authorId: number;
  ownerId: number;
  viewer: { id: number; isModerator?: boolean } | null | undefined;
}) =>
  !!viewer &&
  depth > 0 &&
  (viewer.id === authorId || viewer.id === ownerId || !!viewer.isModerator);

/**
 * Takes a chapter out of its storyline; its post stays published. Only a chapter nothing continues
 * from can go, so for one that has continuations the item says why instead.
 */
export function RemoveChapterMenuItem({
  chapterId,
  title,
  hasChildren,
  byAuthor,
  onRemoved,
}: {
  chapterId: number;
  title: string;
  hasChildren: boolean;
  /** The viewer wrote the chapter, so any Buzz paid to add it was theirs. */
  byAuthor: boolean;
  onRemoved?: () => void;
}) {
  const remove = useRemoveStorylineChapter({ onSuccess: onRemoved });

  const confirmRemove = () =>
    openConfirmModal({
      title: 'Remove chapter',
      children: (
        <Text size="sm">
          Remove <strong>{title}</strong> from the storyline? Its post stays published on its own.
          {byAuthor && ' If you paid to add it, that Buzz is not returned.'}
        </Text>
      ),
      labels: { confirm: 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(chapterId),
    });

  return (
    <Menu.Item
      color="red"
      leftSection={<IconTrash size={14} stroke={1.5} />}
      disabled={hasChildren || remove.isPending}
      onClick={confirmRemove}
    >
      Remove from storyline
      {hasChildren && (
        <Text size="xs" c="dimmed">
          Other chapters continue from this one
        </Text>
      )}
    </Menu.Item>
  );
}
