/**
 * Krea2StyleReferencesInput
 *
 * Single dropzone for up to N reference images. Each accepted image becomes a
 * row below with thumbnail, strength slider, and remove button.
 *
 * Strengths are preserved across re-orders/removals by matching on image URL.
 */

import { Badge, Group, Input, Stack, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { SourceImageUploadMultiple } from '~/components/Generation/Input/SourceImageUploadMultiple';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import { SliderInput } from './SliderInput';

// =============================================================================
// Types
// =============================================================================

export type Krea2StyleReferenceEntry = {
  image?: { url: string; width?: number; height?: number };
  strength: number;
};

export interface Krea2StyleReferencesInputProps {
  value?: Krea2StyleReferenceEntry[] | null;
  onChange?: (value: Krea2StyleReferenceEntry[]) => void;
  meta: {
    limit: number;
    strength: { min: number; max: number; default: number; step: number };
  };
  error?: string;
}

// =============================================================================
// Component
// =============================================================================

export function Krea2StyleReferencesInput({
  value,
  onChange,
  meta,
  error,
}: Krea2StyleReferencesInputProps) {
  const entries = value ?? [];
  const limit = meta.limit;

  // Project entries → SourceImageProps[] for the uploader's controlled value.
  // SourceImageUploadMultiple requires url+width+height; we fall back to 0s if
  // dimensions were never captured (defensive against persisted partial state).
  const uploaderValue: SourceImageProps[] = entries
    .filter((e): e is Krea2StyleReferenceEntry & { image: { url: string } } => !!e.image?.url)
    .map((e) => ({
      url: e.image.url,
      width: e.image.width ?? 0,
      height: e.image.height ?? 0,
    }));

  // Reconcile the entries list with the uploader's image array. Preserve
  // strengths across re-orders/removals/re-uploads by matching on URL.
  function handleImagesChange(images: SourceImageProps[] | null | undefined) {
    const next = images ?? [];
    const strengthByUrl = new Map<string, number>();
    for (const e of entries) {
      if (e.image?.url) strengthByUrl.set(e.image.url, e.strength);
    }
    onChange?.(
      next.map((img) => ({
        image: { url: img.url, width: img.width, height: img.height },
        strength: strengthByUrl.get(img.url) ?? meta.strength.default,
      }))
    );
  }

  function updateStrength(index: number, strength: number) {
    onChange?.(entries.map((e, i) => (i === index ? { ...e, strength } : e)));
  }

  function removeEntry(index: number) {
    onChange?.(entries.filter((_, i) => i !== index));
  }

  return (
    <Input.Wrapper
      label={
        <Group justify="space-between" className="w-full">
          <Group gap={6}>
            <Text component="span" fz="sm" fw={500}>
              Style References
            </Text>
            <Badge size="sm" variant="light" color="gray">
              {entries.length}/{limit}
            </Badge>
          </Group>
        </Group>
      }
      description={`Reference images that steer the visual style. Add up to ${limit}.`}
      error={error}
      classNames={{ label: 'w-full' }}
    >
      <Stack gap="sm" mt={6}>
        <SourceImageUploadMultiple
          value={uploaderValue}
          onChange={handleImagesChange}
          max={limit}
          aspect="square"
        >
          {() => <SourceImageUploadMultiple.Dropzone className="h-24" />}
        </SourceImageUploadMultiple>

        {entries.length > 0 && (
          <Stack gap="xs">
            {entries.map((entry, index) => (
              <StyleReferenceRow
                key={entry.image?.url ?? `sr-${index}`}
                entry={entry}
                index={index}
                strengthMeta={meta.strength}
                onStrengthChange={(v) => updateStrength(index, v)}
                onRemove={() => removeEntry(index)}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Input.Wrapper>
  );
}

// =============================================================================
// Row (thumbnail + strength slider + remove)
// =============================================================================

interface StyleReferenceRowProps {
  entry: Krea2StyleReferenceEntry;
  index: number;
  strengthMeta: Krea2StyleReferencesInputProps['meta']['strength'];
  onStrengthChange: (value: number) => void;
  onRemove: () => void;
}

function StyleReferenceRow({
  entry,
  index,
  strengthMeta,
  onStrengthChange,
  onRemove,
}: StyleReferenceRowProps) {
  return (
    <Group gap="sm" wrap="nowrap" align="center">
      <div className="size-12 shrink-0 overflow-hidden rounded-md bg-gray-1 dark:bg-dark-6">
        {entry.image?.url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={entry.image.url} alt="" className="size-full object-cover" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <SliderInput
          label={
            <Text component="span" fz="xs" fw={500}>
              Ref {index + 1} strength
            </Text>
          }
          value={entry.strength}
          onChange={onStrengthChange}
          min={strengthMeta.min}
          max={strengthMeta.max}
          step={strengthMeta.step}
        />
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove style reference ${index + 1}`}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-gray-2 text-gray-7 transition-colors hover:bg-gray-3 dark:bg-dark-5 dark:text-dark-1 dark:hover:bg-dark-4"
      >
        <IconX size={14} />
      </button>
    </Group>
  );
}
