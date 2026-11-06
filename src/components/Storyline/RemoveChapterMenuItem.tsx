import { Text } from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
import { openConfirmModal } from '@mantine/modals';
import { IconTrash } from '@tabler/icons-react';
import { useRemoveStorylineChapter } from '~/components/Storyline/storyline.data';

/**
 * Who is offered the removal, chapter 1 included so they are told why it can't go; the server
 * decides the rest (a pending continuation, a payment still settling).
 */
export const canRemoveStorylineChapter = ({
  authorId,
  ownerId,
  viewer,
}: {
  authorId: number;
  ownerId: number;
  viewer: { id: number; isModerator?: boolean } | null | undefined;
}) => !!viewer && (viewer.id === authorId || viewer.id === ownerId || !!viewer.isModerator);

/**
 * Takes a chapter out of its storyline; its post stays published. Chapter 1, a chapter others
 * continue from and, for the owner, a chapter someone paid to add can't go, so for those the item
 * is disabled and says why.
 */
export function RemoveChapterMenuItem({
  chapterId,
  title,
  depth,
  takenDown,
  hasChildren,
  byAuthor,
  paid,
  onRemoved,
}: {
  chapterId: number;
  title: string;
  depth: number;
  /** The storyline was taken down, so its owner can't delete it either. */
  takenDown: boolean;
  hasChildren: boolean;
  /** The viewer wrote the chapter, so any Buzz paid to add it was theirs. */
  byAuthor: boolean;
  /** Someone paid the owner to add it, so the owner may not take it out; sent only to the owner. */
  paid?: boolean;
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

  // Chapter 1's way out is "Delete storyline" in the storyline's ⋯ menu, which a takedown hides.
  const refusal =
    depth === 0
      ? takenDown
        ? "Chapter 1 can't be removed"
        : "Chapter 1 can't be removed. Delete the storyline instead"
      : hasChildren
      ? 'Other chapters continue from this one'
      : paid
      ? "Someone paid to add this chapter, so it can't be removed"
      : null;

  return (
    <Menu.Item
      color="red"
      leftSection={<IconTrash size={14} stroke={1.5} />}
      disabled={!!refusal || remove.isPending}
      onClick={confirmRemove}
    >
      Remove from storyline
      {refusal && (
        <Text size="xs" c="dimmed">
          {refusal}
        </Text>
      )}
    </Menu.Item>
  );
}
