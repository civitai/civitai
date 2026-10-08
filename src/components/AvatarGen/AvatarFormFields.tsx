import { Input, SegmentedControl } from '@mantine/core';
import { Controller, useField } from 'form-graph/react';
import type { GenerationStore } from '~/components/form-graph/generation/store';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { AvatarPalettePicker } from './AvatarPalettePicker';
import { AvatarReferenceGrid } from './AvatarReferenceGrid';
import { AvatarStylePicker } from './AvatarStylePicker';

type Option = { label: string; value: string };
const optionsOf = (meta: unknown) => (meta as { options?: Option[] } | undefined)?.options ?? [];

/** The img2img:avatar controls inside the generator form; each field is absent on other workflows. */
export function AvatarFormFields({ store }: { store: GenerationStore }) {
  const isAvatar = !!useField<string>(store, 'avatarStyle');
  if (!isAvatar) return null;

  return (
    <>
      <Controller
        graph={generationHub}
        name="avatarStyle"
        render={({ value }) => (
          <AvatarStylePicker
            value={value}
            onChange={(avatarStyle) =>
              store.set({ avatarStyle, avatarReference: 'cover', avatarParentImage: '' })
            }
          />
        )}
      />
      <AvatarReferenceGrid store={store} />
      <Controller
        graph={generationHub}
        name="avatarCharacter"
        render={({ value, meta, onChange }) => (
          <Input.Wrapper label="Character">
            <SegmentedControl
              fullWidth
              value={value}
              onChange={(next) => onChange(next as never)}
              data={optionsOf(meta)}
            />
          </Input.Wrapper>
        )}
      />
      <Controller
        graph={generationHub}
        name="avatarPalette"
        render={({ value, onChange }) => (
          <AvatarPalettePicker value={value} onChange={(next) => onChange(next as never)} />
        )}
      />
    </>
  );
}
