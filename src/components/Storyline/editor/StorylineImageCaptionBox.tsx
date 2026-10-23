import { Button, Loader, Text, Textarea } from '@mantine/core';
import { IconCheck, IconEye, IconEyeOff } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { StorylineCaptionNote } from '~/components/Storyline/StorylineCaptionNote';
import { usePostImageCaptions } from '~/components/Storyline/editor/usePostImageCaptions';
import { captionCounter } from '~/components/Storyline/editor/storyline-caption.utils';
import { STORYLINE_CAPTION_MAX_LENGTH } from '~/shared/utils/storyline';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The writing of a storyline chapter: what happens in one picture. Saved when the box loses focus;
 * an empty box removes the caption. `media` is the picture, drawn behind the reader's note in the
 * preview.
 */
export function StorylineImageCaptionBox({
  postId,
  imageId,
  media,
}: {
  postId: number;
  imageId: number;
  media: ReactNode;
}) {
  const { captions } = usePostImageCaptions(postId);
  const loaded = captions.get(imageId) ?? '';

  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const value = draft ?? loaded;
  const baseline = saved ?? loaded;

  const mutation = trpc.storyline.setImageCaption.useMutation({
    onSuccess: (_, { content }) => setSaved(content),
    onError: (error) => showErrorNotification({ title: 'Caption not saved', error }),
  });

  const save = () => {
    const content = value.trim();
    if (content === baseline) return;
    mutation.mutate({ imageId, content });
  };

  const counter = captionCounter(value.length);
  const text = value.trim();

  return (
    <div className="flex flex-col gap-1.5" data-testid="storyline-caption-box">
      <Textarea
        aria-label="Caption for this picture"
        placeholder="What happens in this picture? (optional)"
        value={value}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          if (mutation.isError || mutation.isSuccess) mutation.reset();
        }}
        maxLength={STORYLINE_CAPTION_MAX_LENGTH}
        onBlur={save}
        autosize
        minRows={2}
        maxRows={10}
      />
      <div className="flex min-h-[28px] items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            variant="subtle"
            color="blue"
            size="compact-sm"
            leftSection={previewing ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            disabled={!text}
            aria-pressed={previewing}
            onClick={() => setPreviewing((open) => !open)}
          >
            {previewing ? 'Hide preview' : 'Preview'}
          </Button>
          {mutation.isPending && <Loader size="xs" aria-label="Saving" />}
          {mutation.isSuccess && (
            <Text size="sm" c="teal" className="flex items-center gap-1" role="status">
              <IconCheck size={14} aria-hidden /> Saved
            </Text>
          )}
          {mutation.isError && (
            <Text size="sm" c="red" role="status">
              Not saved
            </Text>
          )}
        </div>
        {counter && (
          <Text
            size="sm"
            c={value.length >= STORYLINE_CAPTION_MAX_LENGTH ? 'red' : 'dimmed'}
            aria-live="polite"
          >
            {counter}
          </Text>
        )}
      </div>
      {previewing && !!text && (
        <div
          className="relative overflow-hidden rounded-lg bg-black"
          data-testid="storyline-caption-preview"
        >
          {media}
          <div className="absolute inset-x-2 bottom-2 flex justify-center @container">
            <StorylineCaptionNote key={imageId} caption={text} />
          </div>
        </div>
      )}
    </div>
  );
}
