import { Button, Group, Text, Textarea, TextInput } from '@mantine/core';
import { IconPencil, IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import type { KeyboardEvent, ReactNode } from 'react';
import { useState } from 'react';
import { captionCounter } from '~/components/Storyline/editor/storyline-caption.utils';
import { POST_TITLE_MAX_LENGTH } from '~/server/common/constants';
import { STORYLINE_CAPTION_MAX_LENGTH } from '~/shared/utils/storyline';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const CARD = clsx(
  'flex w-full flex-col gap-2 rounded-2xl p-3 @md:w-[560px] @md:max-w-full',
  'bg-white/95 text-gray-9 shadow-[0_8px_24px_rgba(0,0,0,.3)] ring-1 ring-gray-3/70 backdrop-blur-md',
  'dark:bg-dark-6/95 dark:text-white dark:ring-dark-4/70'
);

/**
 * Escape cancels the edit. The viewer's modal closes on an Escape caught on the window, which it
 * skips only when the key's target carries `data-mantine-stop-propagation`, so the fields carry it.
 */
function cancelOnEscape(cancel: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    cancel();
  };
}

/**
 * The chapter author's edits on the image being read: its caption and the chapter title, saved in
 * place through the same writes the post editor uses. Mount it keyed on the image, for the author
 * only; `children` is the caption note, hidden while the caption is being edited.
 */
export function StorylineAuthorEdit({
  postId,
  title,
  imageId,
  caption,
  children,
}: {
  postId: number;
  title: string | null;
  imageId: number;
  caption: string | undefined;
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState<'caption' | 'title' | null>(null);
  const close = () => setEditing(null);

  return (
    <>
      {editing === null && (
        <Group gap={6} justify="flex-end" data-testid="storyline-author-edit">
          <Button
            size="compact-xs"
            radius="xl"
            variant="white"
            color="dark"
            leftSection={caption ? <IconPencil size={12} /> : <IconPlus size={12} />}
            onClick={() => setEditing('caption')}
          >
            {caption ? 'Edit caption' : 'Add caption'}
          </Button>
          <Button
            size="compact-xs"
            radius="xl"
            variant="white"
            color="dark"
            leftSection={<IconPencil size={12} />}
            onClick={() => setEditing('title')}
          >
            Edit title
          </Button>
        </Group>
      )}
      {editing === 'caption' ? (
        <CaptionEditor imageId={imageId} caption={caption ?? ''} onDone={close} />
      ) : (
        children
      )}
      {editing === 'title' && <TitleEditor postId={postId} title={title ?? ''} onDone={close} />}
    </>
  );
}

function CaptionEditor({
  imageId,
  caption,
  onDone,
}: {
  imageId: number;
  caption: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState(caption);
  const utils = trpc.useUtils();
  const mutation = trpc.storyline.setImageCaption.useMutation({
    onSuccess: async () => {
      await utils.storyline.getPath.invalidate();
      onDone();
    },
    onError: (error) => showErrorNotification({ title: 'Caption not saved', error }),
  });
  const counter = captionCounter(value.length);

  const save = () => {
    const content = value.trim();
    if (content === caption.trim()) return onDone();
    mutation.mutate({ imageId, content });
  };

  return (
    <div className={CARD} onKeyDown={cancelOnEscape(onDone)} data-testid="storyline-caption-edit">
      <Textarea
        label="Caption (shown in the story)"
        placeholder="What happens in this picture?"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        maxLength={STORYLINE_CAPTION_MAX_LENGTH}
        autosize
        minRows={2}
        maxRows={8}
        autoFocus
        // Cursor after the existing text.
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        data-mantine-stop-propagation
      />
      <Group justify="space-between" gap="xs">
        <Text size="xs" c="dimmed" aria-live="polite">
          {counter ?? (caption && !value.trim() ? 'Saving it empty removes the caption.' : '')}
        </Text>
        <Group gap="xs">
          <Button size="compact-sm" variant="default" onClick={onDone}>
            Cancel
          </Button>
          <Button size="compact-sm" onClick={save} loading={mutation.isPending}>
            Save
          </Button>
        </Group>
      </Group>
    </div>
  );
}

function TitleEditor({
  postId,
  title,
  onDone,
}: {
  postId: number;
  title: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState(title);
  const utils = trpc.useUtils();
  const mutation = trpc.post.update.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.storyline.getPath.invalidate(),
        utils.storyline.getForPosts.invalidate(),
        utils.post.get.invalidate({ id: postId }),
      ]);
      onDone();
    },
    onError: (error) => showErrorNotification({ title: 'Title not saved', error }),
  });

  const save = () => {
    const next = value.trim();
    if (next === title.trim()) return onDone();
    mutation.mutate({ id: postId, title: next || null });
  };

  return (
    <form
      className={CARD}
      onKeyDown={cancelOnEscape(onDone)}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      data-testid="storyline-title-edit"
    >
      <TextInput
        label="Chapter title"
        description="The chapter title is the post's title."
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        maxLength={POST_TITLE_MAX_LENGTH}
        autoFocus
        data-mantine-stop-propagation
      />
      <Group justify="flex-end" gap="xs">
        <Button size="compact-sm" variant="default" onClick={onDone}>
          Cancel
        </Button>
        <Button size="compact-sm" type="submit" loading={mutation.isPending}>
          Save
        </Button>
      </Group>
    </form>
  );
}
