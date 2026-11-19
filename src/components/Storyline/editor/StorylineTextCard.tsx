import { ActionIcon, Card, Loader, Text } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconCheck, IconLock, IconTrash } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { usePendingSave, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditor';
import {
  STORYLINE_TEXT_CONTROLS,
  STORYLINE_TEXT_HEADING_LEVELS,
} from '~/components/Storyline/editor/storyline-text.utils';
import type { PostEditTextDetail } from '~/server/services/post.service';
import { STORYLINE_TEXT_MAX_LENGTH } from '~/shared/utils/storyline';
import { useDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const AUTOSAVE_MS = 1000;

/**
 * One text item between a chapter's images, autosaved as the author types. A held item refuses
 * every change with FORBIDDEN; the card then shows its words read-only, with the server's message.
 *
 * A draft (`text` null) has no row yet: the first typed character creates it at `draftIndex`, so
 * an "Add text" that is never typed into leaves nothing behind. The card stays mounted across the
 * create, so the author's typing and caret are not interrupted.
 */
export function StorylineTextCard({
  text,
  label,
  draftIndex = 0,
  onCreated,
  onDismiss,
}: {
  text: PostEditTextDetail | null;
  /** "Text 2 / 20": the card's heading row, with its status and delete beside it. */
  label: string;
  draftIndex?: number;
  onCreated?: (text: PostEditTextDetail) => void;
  onDismiss?: () => void;
}) {
  const setTexts = usePostEditStore((state) => state.setTexts);
  const postId = usePostEditStore((state) => state.post?.id);
  const [id, setId] = useState<number | null>(text?.id ?? null);
  // Read by the editor's change handler, which can run several times before a re-render: render
  // state there would let two quick keystrokes each start a create.
  const idRef = useRef(id);
  const createStarted = useRef(false);
  const [value, setValue] = useState(text?.content ?? '');
  const latest = useRef(value);
  const [heldMessage, setHeldMessage] = useState<string | null>(null);
  const debounce = useDebouncer(AUTOSAVE_MS);
  usePendingSave(`storyline-text-${id ?? 'draft'}`, debounce);
  // A save still inside its debounce window must not die with the card (a draft handing over to
  // its row, a navigation): run it on the way out.
  useEffect(() => debounce.flush, [debounce]);

  const onHeld = (error: { data?: { code?: string } | null; message: string }) => {
    if (error.data?.code !== 'FORBIDDEN') return false;
    debounce.cancel();
    setHeldMessage(error.message);
    return true;
  };

  const save = trpc.storyline.setText.useMutation({
    onSuccess: ({ id, content }) =>
      setTexts((texts) => texts.map((t) => (t.id === id ? { ...t, content } : t))),
    onError: (error) => {
      if (!onHeld(error)) showErrorNotification({ title: 'Text not saved', error });
    },
  });
  const add = trpc.storyline.addText.useMutation({
    onSuccess: (created) => {
      idRef.current = created.id;
      setId(created.id);
      // The list must know this card owns the row before the store has it: the store's update
      // renders at once, and a render with the row but not the owner places it as a second card
      // and moves this one, remounting the editor mid-typing.
      flushSync(() => onCreated?.(created));
      setTexts((texts) => [...texts, created]);
      save.mutate({ id: created.id, content: latest.current });
    },
    onError: (error) => {
      createStarted.current = false;
      showErrorNotification({ title: 'Text not added', error });
    },
  });
  const remove = trpc.storyline.deleteText.useMutation({
    onSuccess: ({ id: removedId }) => {
      setTexts((texts) => texts.filter((t) => t.id !== removedId));
      onDismiss?.();
    },
    onError: (error) => {
      if (!onHeld(error)) showErrorNotification({ title: 'Text not deleted', error });
    },
  });

  const length = removeTags(value).trim().length;
  const tooLong = length > STORYLINE_TEXT_MAX_LENGTH;

  const handleChange = (html: string) => {
    setValue(html);
    latest.current = html;
    const id = idRef.current;
    if (id === null) {
      if (removeTags(html).trim().length > 0 && postId && !createStarted.current) {
        createStarted.current = true;
        add.mutate({ postId, index: draftIndex });
      }
      return;
    }
    if (save.isSuccess || save.isError) save.reset();
    if (removeTags(html).trim().length > STORYLINE_TEXT_MAX_LENGTH) return debounce.cancel();
    debounce(() => save.mutate({ id, content: html }));
  };

  if (heldMessage) {
    return (
      <Card withBorder data-testid="storyline-text-card" data-held>
        <Text size="sm" fw={600} c="dimmed" className="mb-1">
          {label}
        </Text>
        <div className="mb-2 flex items-center gap-2">
          <IconLock size={16} aria-hidden />
          <Text size="sm" c="dimmed" role="status">
            {heldMessage}
          </Text>
        </div>
        <RenderHtml html={text?.content ?? ''} />
      </Card>
    );
  }

  const deleting = remove.isPending;
  const saving = save.isPending || add.isPending;

  return (
    <div data-testid="storyline-text-card" className="flex flex-col gap-1">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <Text size="sm" fw={600} c="dimmed">
          {label}
        </Text>
        <div className="flex items-center gap-2">
          {saving && <Loader size="xs" aria-label="Saving" />}
          {save.isSuccess && (
            <Text size="sm" c="teal" className="flex items-center gap-1" role="status">
              <IconCheck size={14} aria-hidden /> Saved
            </Text>
          )}
          {(save.isError || add.isError) && (
            <Text size="sm" c="red" role="status">
              Not saved
            </Text>
          )}
          {tooLong && (
            <Text size="sm" c="red" role="status">
              {length.toLocaleString()} / {STORYLINE_TEXT_MAX_LENGTH.toLocaleString()} characters
            </Text>
          )}
          <Tooltip label="Delete text">
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label="Delete text"
              loading={deleting}
              // Deleting while the create is in flight would dismiss the card, then the row
              // would still land in the list.
              disabled={add.isPending}
              onClick={() => {
                debounce.cancel();
                if (id === null) onDismiss?.();
                else remove.mutate({ id });
              }}
            >
              <IconTrash size={18} />
            </ActionIcon>
          </Tooltip>
        </div>
      </div>
      <RichTextEditor
        value={value}
        onChange={handleChange}
        includeControls={[...STORYLINE_TEXT_CONTROLS]}
        headingLevels={STORYLINE_TEXT_HEADING_LEVELS}
        compactToolbar
        classNames={{ root: '!border-gray-2 dark:!border-dark-5' }}
        placeholder="Write what happens next..."
        editorSize="md"
        autoFocus={text === null}
        disabled={deleting}
      />
    </div>
  );
}
