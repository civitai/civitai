import {
  ActionIcon,
  Button,
  Card,
  Input,
  NumberInput,
  SegmentedControl,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { ImageUploadMultipleInput } from '~/components/generation_v2/inputs/ImageUploadMultipleInput';
import { VideoInput, type VideoValue } from '~/components/generation_v2/inputs/VideoInput';
import type { KlingV4Element, KlingV4Shot } from '~/shared/form-graph/generation/video/kling.graph';
import { ControllerLabel } from '../form-helpers';

export function KlingReferenceVideosInput({
  value,
  onChange,
  limit,
  error,
}: {
  value?: VideoValue[];
  onChange: (value: VideoValue[]) => void;
  limit: number;
  error?: string;
}) {
  const videos = value ?? [];
  return (
    <div className="flex flex-col gap-2">
      <ControllerLabel
        label={`Reference Videos (${videos.length}/${limit})`}
        info="Videos of 3-30 seconds, at least 700 pixels on each side and 24-60 fps. Reference and source videos may total 30 seconds."
      />
      {videos.map((video, i) => (
        <div key={video.url} className="flex items-start gap-1">
          <VideoInput
            className="flex-1"
            value={video}
            onChange={(next) =>
              onChange(
                next ? videos.map((v, j) => (j === i ? next : v)) : videos.filter((_, j) => j !== i)
              )
            }
          />
        </div>
      ))}
      {videos.length < limit && (
        <VideoInput key={videos.length} onChange={(next) => next && onChange([...videos, next])} />
      )}
      {error && <Input.Error>{error}</Input.Error>}
    </div>
  );
}

export function KlingElementsInput({
  value,
  onChange,
  limit,
  error,
}: {
  value?: KlingV4Element[];
  onChange: (value: KlingV4Element[]) => void;
  limit: number;
  error?: string;
}) {
  const elements = value ?? [];
  const update = (i: number, patch: Partial<KlingV4Element>) =>
    onChange(elements.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <div className="flex flex-col gap-2">
      <ControllerLabel
        label={`Elements (${elements.length}/${limit})`}
        info="Keep a character or object consistent. Give each element a frontal image and one to three more views, or a 3-8 second video, and optionally a voice ID."
      />
      {elements.map((element, i) => {
        const mode = element.video ? 'video' : 'images';
        return (
          <Card key={i} withBorder p="xs" className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <SegmentedControl
                size="xs"
                value={mode}
                onChange={(next) =>
                  update(i, next === 'video' ? { images: [] } : { images: [], video: undefined })
                }
                data={[
                  { label: 'Images', value: 'images' },
                  { label: 'Video', value: 'video' },
                ]}
              />
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label="Remove element"
                onClick={() => onChange(elements.filter((_, j) => j !== i))}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </div>
            {mode === 'images' ? (
              <ImageUploadMultipleInput
                value={element.images}
                onChange={(images) => update(i, { images })}
                aspect="square"
                slots={[
                  { label: 'Frontal', required: true },
                  { label: 'View 2', required: true },
                  { label: 'View 3' },
                  { label: 'View 4' },
                ]}
              />
            ) : null}
            {mode === 'video' || !element.images.length ? (
              <VideoInput
                value={element.video}
                onChange={(video) => update(i, { video, images: [] })}
              />
            ) : null}
            <TextInput
              size="xs"
              placeholder="Voice ID (optional)"
              value={element.voiceId ?? ''}
              onChange={(e) => update(i, { voiceId: e.currentTarget.value || undefined })}
            />
          </Card>
        );
      })}
      {elements.length < limit && (
        <Button
          variant="default"
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() => onChange([...elements, { images: [] }])}
        >
          Add element
        </Button>
      )}
      {error && <Input.Error>{error}</Input.Error>}
    </div>
  );
}

export function KlingMultiShotInput({
  value,
  onChange,
  error,
}: {
  value?: KlingV4Shot[];
  onChange: (value: KlingV4Shot[]) => void;
  error?: string;
}) {
  const shots = value ?? [];
  const total = shots.reduce((sum, s) => sum + s.duration, 0);
  const update = (i: number, patch: Partial<KlingV4Shot>) =>
    onChange(shots.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <div className="flex flex-col gap-2">
      <ControllerLabel
        label={shots.length ? `Shots (${total}s total)` : 'Shots'}
        info="Write a prompt per shot instead of one prompt. The shots play back to back, and the video is as long as the shots added together (3-30 seconds)."
      />
      {shots.map((shot, i) => (
        <div key={i} className="flex items-start gap-2">
          <Textarea
            className="flex-1"
            autosize
            minRows={1}
            maxLength={512}
            placeholder={`Shot ${i + 1}`}
            value={shot.prompt}
            onChange={(e) => update(i, { prompt: e.currentTarget.value })}
          />
          <NumberInput
            className="w-20"
            min={1}
            max={30}
            suffix="s"
            value={shot.duration}
            onChange={(v) => update(i, { duration: Number(v) || 1 })}
          />
          <ActionIcon
            variant="subtle"
            color="red"
            mt={6}
            aria-label="Remove shot"
            onClick={() => onChange(shots.filter((_, j) => j !== i))}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </div>
      ))}
      <Button
        variant="default"
        size="xs"
        leftSection={<IconPlus size={14} />}
        onClick={() => onChange([...shots, { prompt: '', duration: 3 }])}
      >
        Add shot
      </Button>
      {error && <Input.Error>{error}</Input.Error>}
    </div>
  );
}
