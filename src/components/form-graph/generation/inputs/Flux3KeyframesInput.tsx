import { Text } from '@mantine/core';
import { useRef } from 'react';
import { SliderInput } from '~/components/generation_v2/inputs/SliderInput';
import { ImageEntryListInput } from './ImageEntryListInput';
import { byFrame, nextFrameIndex, swapImages, type Flux3KeyframeEntry } from './keyframe-order';

export type { Flux3KeyframeEntry };

export interface Flux3KeyframesInputProps {
  value?: Flux3KeyframeEntry[] | null;
  onChange?: (value: Flux3KeyframeEntry[]) => void;
  meta: { limit: number; maxFrame: number; fps: number };
  error?: string;
}

export function Flux3KeyframesInput({ value, onChange, meta, error }: Flux3KeyframesInputProps) {
  const { limit, maxFrame, fps } = meta;
  // The slider reports a value only on release, but the number box reports every keystroke;
  // re-sorting mid-edit would move the row from under the caret.
  const typing = useRef(false);
  return (
    <ImageEntryListInput
      value={value}
      onChange={(next, options) => onChange?.(options?.live ? next : byFrame(next))}
      limit={limit}
      label="Keyframes"
      description={`Images the video passes through, each at a moment you choose. Add up to ${limit}.`}
      error={error}
      warnOnMissingAiMetadata
      makeEntry={(image, entries) => ({
        image,
        frameIndex: nextFrameIndex(entries, maxFrame, fps),
      })}
      reorder={swapImages}
      renderControl={(entry, index, update) => (
        <SliderInput
          label={
            <Text component="span" fz="xs" fw={500}>
              Keyframe {index + 1} at {(entry.frameIndex / fps).toFixed(1)}s (frame{' '}
              {entry.frameIndex})
            </Text>
          }
          value={entry.frameIndex}
          onChange={(frameIndex) => update({ frameIndex }, { live: typing.current })}
          numberProps={{
            onFocus: () => (typing.current = true),
            onBlur: () => {
              typing.current = false;
              update({});
            },
          }}
          min={0}
          max={maxFrame}
          step={1}
        />
      )}
    />
  );
}
