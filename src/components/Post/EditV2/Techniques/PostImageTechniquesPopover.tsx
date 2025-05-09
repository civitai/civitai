import { Button, Checkbox, Divider, Text, UnstyledButton } from '@mantine/core';
import React, { useMemo, useState } from 'react';
import { AlwaysOpenCombobox } from '~/components/Combobox/AlwaysOpenComboBox';
import { ComboboxOption } from '~/components/Combobox/combobox.types';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import type { PostEditImageDetail } from '~/server/services/post.service';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export function ImageTechniquesPopover({
  image,
  onSuccess,
}: {
  image: PostEditImageDetail;
  onSuccess?: () => void;
}) {
  const { data: techniques = [], isLoading: loadingTechniques } = trpc.technique.getAll.useQuery();
  const [updateImage, imageCount, imageIds] = usePostEditStore((state) => [
    state.updateImage,
    state.images.length,
    state.images.map((x) => (x.type === 'added' ? x.data.id : undefined)).filter(isDefined),
  ]);
  const [showSelected, setShowSelected] = useState(false);
  const [value, setValue] = useState<number[]>(() => []);

  const options: ComboboxOption[] = useMemo(
    () =>
      techniques
        .map((technique) => ({
          label: technique.name,
          value: technique.id,
          group: getDisplayName(technique.type),
        }))
        .filter((x) => {
          if (image.techniques.findIndex((technique) => technique.id === x.value) > -1)
            return false;
          if (showSelected) return value.includes(x.value);
          return true;
        }),
    [techniques, image, showSelected, value]
  );

  const { mutate, isLoading } = trpc.image.addTechniques.useMutation();
  const handleAddTechniques = (multiple?: boolean) => {
    const ids = multiple ? imageIds : [image.id ?? 0];
    const payload = ids.reduce<{ imageId: number; techniqueId: number }[]>(
      (acc, imageId) => [...acc, ...value.map((techniqueId) => ({ imageId, techniqueId }))],
      []
    );
    mutate(
      { data: payload },
      {
        onSuccess: () => {
          handleClose(ids);
          onSuccess?.();
        },
      }
    );
  };

  function handleSetValue(value: number[]) {
    setValue(value);
    if (!value.length) setShowSelected(false);
  }

  function handleClose(ids?: number[]) {
    setTimeout(() => {
      handleSetValue([]);
      if (!image.id || !ids?.length) return;
      for (const id of ids) {
        updateImage(id, (image) => {
          const newTechniques = value.map((techniqueId) => {
            const technique = techniques.find((x) => x.id === techniqueId);
            return {
              id: techniqueId,
              name: technique?.name ?? '',
              notes: null,
            } as PostEditImageDetail['techniques'][number];
          });
          image.techniques = [
            ...image.techniques,
            ...newTechniques.filter((x) => image.techniques.findIndex((y) => y.id === x.id) === -1),
          ];
        });
      }
    }, 300);
  }

  return (
    <AlwaysOpenCombobox
      value={value}
      onChange={handleSetValue}
      options={options}
      loading={loadingTechniques}
      showSelected={showSelected}
      renderOption={({ selected, label }) => (
        <>
          <span>{label}</span>
          <Checkbox checked={selected} readOnly tabIndex={-1} />
        </>
      )}
      footer={
        !!value.length && (
          <div className="flex flex-col gap-2 p-2 pt-0">
            <div>
              <Divider />
              <div className="flex justify-center">
                <UnstyledButton
                  className="m-1 cursor-pointer"
                  onClick={() => setShowSelected((b) => !b)}
                >
                  <Text variant="link" align="center">
                    {!showSelected ? `Show ${value.length} selected` : `Show all`}
                  </Text>
                </UnstyledButton>
              </div>
              <Divider />
            </div>
            <Button size="compact-md" disabled={isLoading} onClick={() => handleAddTechniques()}>
              Add
            </Button>
            {imageCount > 1 && (
              <Button
                className="text-sm"
                variant="default"
                size="compact-md"
                disabled={isLoading}
                onClick={() => handleAddTechniques(true)}
              >
                Add to all images ({imageCount})
              </Button>
            )}
          </div>
        )
      }
    />
  );
}
