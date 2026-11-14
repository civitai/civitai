import { ActionIcon, Card, Loader, Text } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconCheck, IconLock, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
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
 */
export function StorylineTextCard({ text }: { text: PostEditTextDetail }) {
  const setTexts = usePostEditStore((state) => state.setTexts);
  const [value, setValue] = useState(text.content);
  const [heldMessage, setHeldMessage] = useState<string | null>(null);
  const debounce = useDebouncer(AUTOSAVE_MS);
  usePendingSave(`storyline-text-${text.id}`, debounce);

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
  const remove = trpc.storyline.deleteText.useMutation({
    onSuccess: ({ id }) => setTexts((texts) => texts.filter((t) => t.id !== id)),
    onError: (error) => {
      if (!onHeld(error)) showErrorNotification({ title: 'Text not deleted', error });
    },
  });

  const length = removeTags(value).trim().length;
  const tooLong = length > STORYLINE_TEXT_MAX_LENGTH;

  const handleChange = (html: string) => {
    setValue(html);
    if (save.isSuccess || save.isError) save.reset();
    if (removeTags(html).trim().length > STORYLINE_TEXT_MAX_LENGTH) return debounce.cancel();
    debounce(() => save.mutate({ id: text.id, content: html }));
  };

  if (heldMessage) {
    return (
      <Card withBorder data-testid="storyline-text-card" data-held>
        <div className="mb-2 flex items-center gap-2">
          <IconLock size={16} aria-hidden />
          <Text size="sm" c="dimmed" role="status">
            {heldMessage}
          </Text>
        </div>
        <RenderHtml html={text.content} />
      </Card>
    );
  }

  return (
    <div data-testid="storyline-text-card">
      <RichTextEditor
        value={value}
        onChange={handleChange}
        includeControls={[...STORYLINE_TEXT_CONTROLS]}
        headingLevels={STORYLINE_TEXT_HEADING_LEVELS}
        placeholder="Write what happens next..."
        editorSize="md"
        disabled={remove.isPending}
        toolbarEnd={
          <>
            {save.isPending && <Loader size="xs" aria-label="Saving" />}
            {save.isSuccess && (
              <Text size="sm" c="teal" className="flex items-center gap-1" role="status">
                <IconCheck size={14} aria-hidden /> Saved
              </Text>
            )}
            {save.isError && (
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
                loading={remove.isPending}
                onClick={() => {
                  debounce.cancel();
                  remove.mutate({ id: text.id });
                }}
              >
                <IconTrash size={18} />
              </ActionIcon>
            </Tooltip>
          </>
        }
      />
    </div>
  );
}
