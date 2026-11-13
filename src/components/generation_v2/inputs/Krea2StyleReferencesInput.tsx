import { Text } from '@mantine/core';
import { ImageEntryListInput } from '~/components/form-graph/generation/inputs/ImageEntryListInput';
import type { ImageObjectValue } from '~/shared/generation/values';
import { SliderInput } from './SliderInput';

export type Krea2StyleReferenceEntry = { image?: ImageObjectValue; strength: number };

export interface Krea2StyleReferencesInputProps {
  value?: Krea2StyleReferenceEntry[] | null;
  onChange?: (value: Krea2StyleReferenceEntry[]) => void;
  meta: {
    limit: number;
    strength: { min: number; max: number; default: number; step: number };
  };
  error?: string;
}

export function Krea2StyleReferencesInput({
  value,
  onChange,
  meta,
  error,
}: Krea2StyleReferencesInputProps) {
  const { limit, strength } = meta;
  return (
    <ImageEntryListInput
      value={value}
      onChange={onChange}
      limit={limit}
      label="Style References"
      description={`Reference images that steer the visual style. Add up to ${limit}.`}
      error={error}
      makeEntry={(image) => ({ image, strength: strength.default })}
      renderControl={(entry, index, update) => (
        <SliderInput
          label={
            <Text component="span" fz="xs" fw={500}>
              Ref {index + 1} strength
            </Text>
          }
          value={entry.strength}
          onChange={(value) => update({ strength: value })}
          min={strength.min}
          max={strength.max}
          step={strength.step}
        />
      )}
    />
  );
}
