import { ActionIcon, Input, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useField } from 'form-graph/react';
import type { GenerationStore } from '~/components/form-graph/generation/store';
import { avatarStarterSrc, avatarStartersFor } from '~/shared/constants/avatar-starters';
import {
  avatarEditModelByVersionId,
  avatarStyleByKey,
} from '~/shared/constants/avatar-styles.constants';

type Tile = { value: string; src: string; label: string };

/** The style's stored starters; the first doubles as 'cover', the graph's default reference. */
function starterTiles(styleKey: string): Tile[] {
  return avatarStartersFor(styleKey).map((starter, index) => ({
    value: index === 0 ? 'cover' : `starter:${starter.character}`,
    src: avatarStarterSrc(starter),
    label: starter.character[0].toUpperCase() + starter.character.slice(1),
  }));
}

export function AvatarReferenceGrid({ store }: { store: GenerationStore }) {
  const styleKey = useField<string>(store, 'avatarStyle')?.value;
  const reference = useField<string>(store, 'avatarReference')?.value;
  const parentImage = useField<string>(store, 'avatarParentImage')?.value || undefined;
  const modelId = useField<{ id: number }>(store, 'model')?.value?.id;
  const style = styleKey ? avatarStyleByKey.get(styleKey) : undefined;
  if (!style) return null;

  const editModel = modelId != null ? avatarEditModelByVersionId.get(modelId) : undefined;
  if (parentImage || (editModel && !editModel.usesReference))
    return (
      <RefineOnlyReference
        store={store}
        modelLabel={editModel?.label ?? 'This model'}
        parentImage={parentImage}
      />
    );

  const tiles = starterTiles(style.key);

  return (
    <Input.Wrapper label="Reference">
      <Text size="sm" className="mb-2 rounded-md bg-gray-1 px-3 py-2 dark:bg-dark-5">
        The reference sets the art style only. The person in it is never copied: your photo decides
        who appears.
      </Text>
      <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Reference">
        {tiles.map((tile) => {
          const selected = tile.value === reference;
          return (
            <UnstyledButton
              key={tile.value}
              role="radio"
              aria-checked={selected}
              onClick={() =>
                store.set({
                  avatarReference: tile.value,
                  avatarParentImage: '',
                })
              }
              className={clsx(
                'relative overflow-hidden rounded-md',
                selected
                  ? 'ring-4 ring-blue-5 ring-offset-2 dark:ring-offset-dark-7'
                  : 'opacity-80 hover:opacity-100'
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={tile.src} alt={tile.label} className="aspect-square w-full object-cover" />
              {selected && (
                <span className="absolute right-1 top-1 rounded-full bg-blue-6 p-0.5 text-white">
                  <IconCheck size={14} />
                </span>
              )}
              <Text
                size="xs"
                className="absolute inset-x-0 bottom-0 bg-black/60 text-center text-white"
              >
                {tile.label}
              </Text>
            </UnstyledButton>
          );
        })}
      </div>
    </Input.Wrapper>
  );
}

/** The result being refined. Krea 2 takes no style reference, so it also shows a note instead. */
function RefineOnlyReference({
  store,
  modelLabel,
  parentImage,
}: {
  store: GenerationStore;
  modelLabel: string;
  parentImage?: string;
}) {
  if (!parentImage)
    return (
      <Input.Wrapper label="Reference">
        <Text size="sm" className="rounded-md bg-gray-1 px-3 py-2 dark:bg-dark-5">
          {modelLabel} restyles your photo with the style itself. To refine a result, press Refine
          on it in the queue.
        </Text>
      </Input.Wrapper>
    );

  return (
    <Input.Wrapper label="Refining from">
      <div className="relative mt-1 w-28 overflow-hidden rounded-md ring-4 ring-blue-5 ring-offset-2 dark:ring-offset-dark-7">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={parentImage}
          alt="Result being refined"
          className="aspect-square w-full object-cover"
        />
        <Tooltip label="Stop refining">
          <ActionIcon
            size="sm"
            radius="xl"
            color="dark"
            variant="filled"
            aria-label="Stop refining"
            className="absolute right-1 top-1"
            onClick={() => store.set({ avatarReference: 'cover', avatarParentImage: '' })}
          >
            <IconX size={14} />
          </ActionIcon>
        </Tooltip>
      </div>
    </Input.Wrapper>
  );
}
