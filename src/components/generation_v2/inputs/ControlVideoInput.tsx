/**
 * Video ControlNet for engines whose control input is a clip rather than an
 * image. `mode: 'preprocessed'` means the user brought their own control map,
 * so the preprocessor is skipped. Supported preprocessors come from the graph
 * node via `meta.options`.
 */

import {
  Button,
  Group,
  Input,
  RangeSlider,
  SegmentedControl,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { IconVideo, IconX } from '@tabler/icons-react';
import React, { useEffect, useMemo, useState } from 'react';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import {
  controlNetCategories,
  controlNetPreprocessors,
  getControlNetPreprocessorExamples,
  type ControlNetCategory,
  type VideoControlNetPreprocessorKey,
} from '~/shared/constants/controlnets.constants';
import type { VideoValue } from '~/shared/data-graph/generation/common';
import { PreprocessorExamples } from './PreprocessorExamples';
import { SliderInput } from './SliderInput';
import { VideoInput } from './VideoInput';

export type ControlVideoMode = 'auto' | 'preprocessed';

export type ControlVideoEntry = {
  preprocessor: VideoControlNetPreprocessorKey;
  mode: ControlVideoMode;
  // Optional on the client — an entry without a video is filtered out of the
  // graph's output, so it never reaches the orchestrator.
  video?: VideoValue;
  strength: number;
  startPercent: number;
  endPercent: number;
};

type PreprocessorOption = {
  value: VideoControlNetPreprocessorKey;
  label: string;
  description: string;
  category: ControlNetCategory;
  recommended: boolean;
};

export interface ControlVideoInputProps {
  value?: ControlVideoEntry | null;
  onChange?: (value: ControlVideoEntry | undefined) => void;
  meta: {
    options: PreprocessorOption[];
    strength: { min: number; max: number; default: number; step: number };
    percent: { min: number; max: number; step: number };
  };
  error?: string;
}

function defaultEntry(meta: ControlVideoInputProps['meta']): ControlVideoEntry {
  const recommended = meta.options.find((o) => o.recommended) ?? meta.options[0];
  return {
    preprocessor: recommended.value,
    mode: 'auto',
    strength: meta.strength.default,
    startPercent: meta.percent.min,
    endPercent: meta.percent.max,
  };
}

export function ControlVideoInput({ value, onChange, meta, error }: ControlVideoInputProps) {
  const entry = value ?? undefined;

  const { categoryOptions, preprocessorsByCategory } = useMemo(() => {
    const byCategory = new Map<ControlNetCategory, PreprocessorOption[]>();
    for (const option of meta.options) {
      const bucket = byCategory.get(option.category);
      if (bucket) bucket.push(option);
      else byCategory.set(option.category, [option]);
    }
    return {
      categoryOptions: [...byCategory.keys()].map((category) => ({
        value: category,
        label: controlNetCategories[category].label,
      })),
      preprocessorsByCategory: byCategory,
    };
  }, [meta.options]);

  // Mantine's RangeSlider drag breaks if the parent re-renders the value on
  // every mousemove — commit on onChangeEnd only.
  const startPercent = entry?.startPercent;
  const endPercent = entry?.endPercent;
  const [range, setRange] = useState<[number, number]>([
    startPercent ?? meta.percent.min,
    endPercent ?? meta.percent.max,
  ]);
  useEffect(() => {
    if (startPercent !== undefined && endPercent !== undefined)
      setRange([startPercent, endPercent]);
  }, [startPercent, endPercent]);

  if (!meta.options.length) return null;

  function update(patch: Partial<ControlVideoEntry>) {
    onChange?.({ ...(entry ?? defaultEntry(meta)), ...patch });
  }

  if (!entry) {
    return (
      <Input.Wrapper label="ControlNet" error={error}>
        <Button
          variant="light"
          leftSection={<IconVideo size={16} />}
          onClick={() => onChange?.(defaultEntry(meta))}
          fullWidth
        >
          Add a control video
        </Button>
      </Input.Wrapper>
    );
  }

  // A preprocessor outside the shared dictionary would throw here and take the
  // whole form down, not just this input. Reachable only if the graph allowlist
  // and the dictionary drift apart.
  const info = controlNetPreprocessors[entry.preprocessor];
  if (!info) return null;
  const activeCategory = info.category;
  const categoryPreprocessors = preprocessorsByCategory.get(activeCategory) ?? [];

  return (
    <Input.Wrapper error={error}>
      <Stack gap="xs">
        <Group justify="space-between">
          <Group gap={4}>
            <Text size="sm" fw={500}>
              ControlNet
            </Text>
            <InfoPopover size="xs" withinPortal>
              <Text size="xs">{controlNetCategories[activeCategory].description}</Text>
            </InfoPopover>
          </Group>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={<IconX size={14} />}
            onClick={() => onChange?.(undefined)}
          >
            Remove
          </Button>
        </Group>

        <VideoInput
          value={entry.video}
          onChange={(video) => update({ video: video as VideoValue | undefined })}
        />

        <SegmentedControl
          value={entry.mode}
          onChange={(mode) => update({ mode: mode as ControlVideoMode })}
          data={[
            { value: 'auto', label: 'Preprocess for me' },
            { value: 'preprocessed', label: 'Already preprocessed' },
          ]}
          fullWidth
          size="xs"
        />

        <Group grow align="flex-start">
          <Select
            label="Type"
            value={activeCategory}
            data={categoryOptions}
            onChange={(category) => {
              if (!category) return;
              const options = preprocessorsByCategory.get(category as ControlNetCategory) ?? [];
              const next = options.find((o) => o.recommended) ?? options[0];
              if (next) update({ preprocessor: next.value });
            }}
            comboboxProps={{ withinPortal: true }}
          />
          <Select
            label="Preprocessor"
            description={
              entry.mode === 'preprocessed'
                ? 'Only labels your control map — the model reads the type from the video itself'
                : undefined
            }
            value={entry.preprocessor}
            data={categoryPreprocessors.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(preprocessor) => {
              if (preprocessor)
                update({ preprocessor: preprocessor as VideoControlNetPreprocessorKey });
            }}
            comboboxProps={{ withinPortal: true }}
          />
        </Group>

        <PreprocessorExamples
          examples={getControlNetPreprocessorExamples(entry.preprocessor)}
          description={info.description}
          note="Preview shown on a still image — the preprocessor runs over every frame of your video."
        />

        <SliderInput
          label="Strength"
          value={entry.strength}
          onChange={(strength) => update({ strength })}
          min={meta.strength.min}
          max={meta.strength.max}
          step={meta.strength.step}
        />

        <Input.Wrapper label="Active range">
          <RangeSlider
            value={range}
            onChange={setRange}
            onChangeEnd={([startPercent, endPercent]) => update({ startPercent, endPercent })}
            min={meta.percent.min}
            max={meta.percent.max}
            step={meta.percent.step}
            // Mantine's default minRange is 10, which exceeds our 0–1 track and
            // locks both thumbs. Allow them to touch.
            minRange={0}
            label={(v) => `${Math.round(v * 100)}%`}
          />
        </Input.Wrapper>
      </Stack>
    </Input.Wrapper>
  );
}
