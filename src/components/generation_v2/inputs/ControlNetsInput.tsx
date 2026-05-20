/**
 * ControlNetsInput
 *
 * Up to N ControlNet entries rendered as image-tile chips at the top of the
 * section. The active chip's editor is shown below as a single pane. Each
 * entry has:
 *   - category   (Edges, Depth, Pose, …)
 *   - preprocessor (filtered to the chosen category)
 *   - reference image (drag-drop, optional — entries without an image are
 *     dropped from the graph output)
 *   - weight (0–2)
 *   - active step range (RangeSlider, 0–1)
 *
 * The list of supported preprocessors is provided by the graph node via
 * `meta.options` — this component derives the visible categories and the
 * per-category preprocessor lists from that.
 */

import { Badge, Group, Input, RangeSlider, Select, Stack, Text, Tooltip } from '@mantine/core';
import { IconPhoto, IconPlus, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import React, { useEffect, useMemo, useState } from 'react';
import {
  controlNetCategories,
  controlNetPreprocessors,
  type ControlNetCategory,
  type ControlNetPreprocessorKey,
} from '~/shared/constants/controlnets.constants';
import { SliderInput } from './SliderInput';
import { ImageUploadMultipleInput, type ImageValue } from './ImageUploadMultipleInput';

// =============================================================================
// Types
// =============================================================================

export type ControlNetEntry = {
  preprocessor: ControlNetPreprocessorKey;
  // Optional on the client — entries without an image are filtered out of the
  // graph's output before validation, so they never reach the orchestrator.
  image?: { url: string; width?: number; height?: number };
  weight: number;
  startStep: number;
  endStep: number;
};

/** Option shape emitted by `controlNetsNode` meta. */
type PreprocessorOption = {
  value: ControlNetPreprocessorKey;
  label: string;
  description: string;
  category: ControlNetCategory;
  recommended: boolean;
  requiresPreprocessedImage: boolean;
};

export interface ControlNetsInputProps {
  value?: ControlNetEntry[] | null;
  onChange?: (value: ControlNetEntry[]) => void;
  meta: {
    options: PreprocessorOption[];
    limit: number;
    weight: { min: number; max: number; default: number; step: number };
    step: { min: number; max: number; step: number };
  };
  error?: string;
}

// =============================================================================
// Component
// =============================================================================

export function ControlNetsInput({ value, onChange, meta, error }: ControlNetsInputProps) {
  const entries = value ?? [];
  const limit = meta.limit;
  const canAdd = entries.length < limit;

  // Which chip is selected for editing. Defaults to the first entry; falls
  // back to a neighboring entry when the active one is removed.
  const [activeIndex, setActiveIndex] = useState<number>(0);
  // Whether the editor pane below the tiles is expanded. Re-clicking the
  // active tile toggles this; the chevron in the editor header does too.
  const [editorOpen, setEditorOpen] = useState<boolean>(true);
  useEffect(() => {
    if (entries.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
      return;
    }
    if (activeIndex >= entries.length) setActiveIndex(entries.length - 1);
  }, [entries.length, activeIndex]);

  function handleSelectTile(index: number) {
    if (index === activeIndex) {
      // Re-clicking the active tile toggles the editor.
      setEditorOpen((open) => !open);
    } else {
      // Switching to a different tile always opens the editor.
      setActiveIndex(index);
      setEditorOpen(true);
    }
  }

  // Group preprocessors by category for the dependent select.
  const { categoryOptions, preprocessorsByCategory } = useMemo(() => {
    const byCategory = new Map<ControlNetCategory, PreprocessorOption[]>();
    for (const opt of meta.options) {
      const bucket = byCategory.get(opt.category);
      if (bucket) bucket.push(opt);
      else byCategory.set(opt.category, [opt]);
    }
    const categories: ControlNetCategory[] = [...byCategory.keys()];
    const catOpts = categories.map((cat) => ({
      value: cat,
      label: controlNetCategories[cat].label,
    }));
    return { categoryOptions: catOpts, preprocessorsByCategory: byCategory };
  }, [meta.options]);

  function updateEntry(index: number, patch: Partial<ControlNetEntry>) {
    onChange?.(entries.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  }

  function removeEntry(index: number) {
    onChange?.(entries.filter((_, i) => i !== index));
  }

  function addEntry() {
    const firstCategory = categoryOptions[0]?.value as ControlNetCategory | undefined;
    if (!firstCategory) return;
    const pool = preprocessorsByCategory.get(firstCategory) ?? [];
    const recommended = pool.find((p) => p.recommended) ?? pool[0];
    if (!recommended) return;

    const newEntry: ControlNetEntry = {
      preprocessor: recommended.value,
      weight: meta.weight.default,
      startStep: meta.step.min,
      endStep: meta.step.max,
    };
    onChange?.([...entries, newEntry]);
    setActiveIndex(entries.length);
    setEditorOpen(true);
  }

  const activeEntry = entries[activeIndex];

  return (
    <Input.Wrapper
      label={
        <Group justify="space-between" className="w-full">
          <Group gap={6}>
            <Text component="span" fz="sm" fw={500}>
              ControlNets
            </Text>
            <Badge size="sm" variant="light" color="gray">
              {entries.length}/{limit}
            </Badge>
          </Group>
        </Group>
      }
      description="Steer generation using a reference image. Add up to four control signals."
      error={error}
      classNames={{ label: 'w-full' }}
    >
      <div
        className={clsx(
          // Negative horizontal margin offsets the parent AccordionLayout's
          // `px="sm"` (12px) so the ControlNets container extends edge-to-edge
          // within the accordion. Top margin keeps a small gap below the label.
          '-mx-3 mt-1.5 border border-solid border-gray-3 dark:border-dark-4',
          'bg-gray-0 dark:bg-dark-6'
        )}
      >
        {entries.length === 0 ? (
          <div className="p-2">
            <button
              type="button"
              onClick={addEntry}
              aria-label="Add ControlNet"
              className={clsx(
                'flex h-20 w-full cursor-pointer flex-row items-center justify-center gap-2',
                'rounded-md border border-dashed border-gray-4',
                'bg-transparent text-gray-7 transition-colors hover:bg-gray-1',
                'dark:border-dark-4 dark:text-dark-1 dark:hover:bg-dark-5'
              )}
            >
              <IconPlus size={22} />
              <Text fz="sm" fw={500}>
                Add ControlNet
              </Text>
            </button>
          </div>
        ) : (
          <div className="p-2">
            <Group gap="xs" wrap="wrap" align="flex-start">
              {entries.map((entry, index) => (
                <ControlNetTile
                  key={`cn-${index}`}
                  entry={entry}
                  isActive={index === activeIndex}
                  onSelect={() => handleSelectTile(index)}
                  onRemove={() => removeEntry(index)}
                />
              ))}
              {canAdd && (
                <Tooltip label="Add ControlNet" withArrow position="top">
                  <button
                    type="button"
                    onClick={addEntry}
                    aria-label="Add ControlNet"
                    className={clsx(
                      'flex w-20 shrink-0 cursor-pointer flex-col items-center justify-center gap-1',
                      'size-20 rounded-md border border-dashed border-gray-4 dark:border-dark-4',
                      'bg-transparent text-gray-6 transition-colors hover:bg-gray-1',
                      'dark:text-dark-2 dark:hover:bg-dark-5'
                    )}
                  >
                    <IconPlus size={22} />
                  </button>
                </Tooltip>
              )}
            </Group>
          </div>
        )}

        {activeEntry && editorOpen && (
          <ControlNetEditor
            entry={activeEntry}
            meta={meta}
            categoryOptions={categoryOptions}
            preprocessorsByCategory={preprocessorsByCategory}
            onChange={(patch) => updateEntry(activeIndex, patch)}
          />
        )}
      </div>
    </Input.Wrapper>
  );
}

// =============================================================================
// ControlNet Tile (selectable image-tile chip)
// =============================================================================

interface ControlNetTileProps {
  entry: ControlNetEntry;
  isActive: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

function ControlNetTile({ entry, isActive, onSelect, onRemove }: ControlNetTileProps) {
  const preprocessorInfo = controlNetPreprocessors[entry.preprocessor];

  return (
    <div className="flex w-20 shrink-0 flex-col items-center gap-1">
      <button
        type="button"
        onClick={onSelect}
        className={clsx(
          'relative size-20 cursor-pointer overflow-hidden rounded-md border-0 p-0',
          'bg-gray-1 transition-all dark:bg-dark-6',
          isActive
            ? 'outline outline-2 outline-offset-2 outline-blue-5'
            : 'opacity-80 hover:opacity-100'
        )}
        aria-label={`Edit ${preprocessorInfo.label}`}
        aria-pressed={isActive}
      >
        {entry.image?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={entry.image.url}
            alt=""
            className="size-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
            }}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-gray-5 dark:text-dark-2">
            <IconPhoto size={20} stroke={1.5} />
          </div>
        )}
        <span
          role="button"
          tabIndex={0}
          aria-label="Remove ControlNet"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onRemove();
            }
          }}
          className={clsx(
            'absolute right-0.5 top-0.5 flex size-4 cursor-pointer items-center justify-center',
            'rounded-full bg-black/70 text-white hover:bg-black/90'
          )}
        >
          <IconX size={12} />
        </span>
      </button>
      <Text
        fz="xs"
        fw={isActive ? 600 : 400}
        c={isActive ? undefined : 'dimmed'}
        className="line-clamp-2 w-full text-center leading-tight"
      >
        {preprocessorInfo.label}
      </Text>
    </div>
  );
}

// =============================================================================
// ControlNet Editor (single pane for the active tile)
// =============================================================================

interface ControlNetEditorProps {
  entry: ControlNetEntry;
  meta: ControlNetsInputProps['meta'];
  categoryOptions: { value: string; label: string }[];
  preprocessorsByCategory: Map<ControlNetCategory, PreprocessorOption[]>;
  onChange: (patch: Partial<ControlNetEntry>) => void;
}

function ControlNetEditor({
  entry,
  meta,
  categoryOptions,
  preprocessorsByCategory,
  onChange,
}: ControlNetEditorProps) {
  const preprocessorInfo = controlNetPreprocessors[entry.preprocessor];
  const currentCategory = preprocessorInfo.category;
  const categoryPreprocessors = preprocessorsByCategory.get(currentCategory) ?? [];

  // Local state for the step range so dragging stays smooth — Mantine's
  // RangeSlider drag handler gets disrupted if the parent re-renders the
  // value on every mousemove. We mirror graph value into local state and
  // commit only on `onChangeEnd`.
  const [stepRange, setStepRange] = useState<[number, number]>([entry.startStep, entry.endStep]);
  useEffect(() => {
    setStepRange([entry.startStep, entry.endStep]);
  }, [entry.startStep, entry.endStep]);

  const preprocessorSelectData = categoryPreprocessors.map((p) => ({
    value: p.value,
    label: p.label,
  }));

  function handleCategoryChange(nextCategory: string | null) {
    if (!nextCategory || nextCategory === currentCategory) return;
    const pool = preprocessorsByCategory.get(nextCategory as ControlNetCategory) ?? [];
    const next = pool.find((p) => p.recommended) ?? pool[0];
    if (next) onChange({ preprocessor: next.value });
  }

  function handlePreprocessorChange(nextValue: string | null) {
    if (!nextValue) return;
    onChange({ preprocessor: nextValue as ControlNetPreprocessorKey });
  }

  function handleImageChange(images: ImageValue[]) {
    const image = images[0];
    if (!image) {
      onChange({ image: undefined });
      return;
    }
    onChange({ image: { url: image.url, width: image.width, height: image.height } });
  }

  return (
    <Stack
      gap="sm"
      p="sm"
      className={clsx(
        'border-0 border-t border-solid border-gray-3 dark:border-dark-4',
        'bg-white dark:bg-dark-7'
      )}
    >
      <ImageUploadMultipleInput
        value={entry.image?.url ? [entry.image as ImageValue] : []}
        onChange={handleImageChange}
        max={1}
        aspect="square"
      />

      <Select
        label="Category"
        data={categoryOptions}
        value={currentCategory}
        onChange={handleCategoryChange}
        allowDeselect={false}
        renderOption={({ option }) => {
          const info = controlNetCategories[option.value as ControlNetCategory];
          return (
            <div className="flex flex-col">
              <Text fz="sm" fw={500}>
                {info.label}
              </Text>
              <Text fz="xs" c="dimmed" className="whitespace-normal">
                {info.description}
              </Text>
            </div>
          );
        }}
        comboboxProps={{ withinPortal: true }}
      />

      <Select
        label="Preprocessor"
        data={preprocessorSelectData}
        value={entry.preprocessor}
        onChange={handlePreprocessorChange}
        allowDeselect={false}
        renderOption={({ option }) => {
          const p = controlNetPreprocessors[option.value as ControlNetPreprocessorKey];
          return (
            <div className="flex flex-col gap-0.5">
              <Group gap={6} wrap="nowrap">
                <Text fz="sm" fw={500}>
                  {p.label}
                </Text>
                {p.recommended && (
                  <Badge size="xs" color="green" variant="light">
                    Recommended
                  </Badge>
                )}
                {p.requiresPreprocessedImage && (
                  <Badge size="xs" color="yellow" variant="light">
                    Pre-processed
                  </Badge>
                )}
              </Group>
              <Text fz="xs" c="dimmed" className="whitespace-normal">
                {p.description}
              </Text>
            </div>
          );
        }}
        comboboxProps={{ withinPortal: true }}
      />
      <Text fz="xs" c="dimmed" mt={-6}>
        {preprocessorInfo.description}
      </Text>
      {preprocessorInfo.requiresPreprocessedImage && (
        <Text fz="xs" c="yellow">
          This preprocessor requires an image you have already processed (no auto-preprocess).
        </Text>
      )}

      <SliderInput
        label="Weight"
        value={entry.weight}
        onChange={(v) => onChange({ weight: v })}
        min={meta.weight.min}
        max={meta.weight.max}
        step={meta.weight.step}
      />

      <Input.Wrapper
        label={
          <Group justify="space-between" className="w-full">
            <Text component="span" fz="sm" fw={500}>
              Active steps
            </Text>
            <Text component="span" fz="xs" c="dimmed">
              {stepRange[0].toFixed(2)} – {stepRange[1].toFixed(2)}
            </Text>
          </Group>
        }
        classNames={{ label: 'w-full' }}
      >
        <RangeSlider
          min={meta.step.min}
          max={meta.step.max}
          step={meta.step.step}
          // Mantine's default minRange is 10, which exceeds our 0–1 track
          // and locks the slider entirely. Allow thumbs to touch.
          minRange={0}
          value={stepRange}
          onChange={setStepRange}
          onChangeEnd={([startStep, endStep]) => onChange({ startStep, endStep })}
          marks={[
            { value: 0, label: '0' },
            { value: 0.25, label: '' },
            { value: 0.5, label: '0.5' },
            { value: 0.75, label: '' },
            { value: 1, label: '1' },
          ]}
          label={(v) => v.toFixed(2)}
          mt={6}
          mb={20}
        />
      </Input.Wrapper>
    </Stack>
  );
}
