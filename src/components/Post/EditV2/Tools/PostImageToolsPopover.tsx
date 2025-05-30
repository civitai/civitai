import { Button, Checkbox, Divider, Text, UnstyledButton } from '@mantine/core';
import React, { useMemo, useState } from 'react';
import { AlwaysOpenCombobox } from '~/components/Combobox/AlwaysOpenComboBox';
import type { ComboboxOption } from '~/components/Combobox/combobox.types';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { useQueryTools } from '~/components/Tool/tools.utils';
import type { PostEditImageDetail } from '~/server/services/post.service';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export function ImageToolsPopover({
  image,
  onSuccess,
}: {
  image: PostEditImageDetail;
  onSuccess?: () => void;
}) {
  const { tools, loading: loadingTools } = useQueryTools({ filters: { include: ['unlisted'] } });
  const [updateImage, imageCount, imageIds] = usePostEditStore((state) => [
    state.updateImage,
    state.images.length,
    state.images.map((x) => (x.type === 'added' ? x.data.id : undefined)).filter(isDefined),
  ]);
  const [showSelected, setShowSelected] = useState(false);
  const [value, setValue] = useState<number[]>(() => []);

  const options: ComboboxOption[] = useMemo(
    () =>
      tools
        .sort((a, b) => {
          if (a.priority || b.priority) {
            return (a.priority ?? 999) - (b.priority ?? 999);
          } else {
            if (a.name.toLowerCase() < b.name.toLowerCase()) {
              return -1;
            }
            if (a.name.toLowerCase() > b.name.toLowerCase()) {
              return 1;
            }
            return 0;
          }
        })
        .map((tool) => ({
          label: tool.name,
          value: tool.id,
          group: getDisplayName(tool.type),
        }))
        .filter((x) => {
          if (image.tools.findIndex((tool) => tool.id === x.value) > -1) return false;
          if (showSelected) return value.includes(x.value);
          return true;
        }),
    [tools, image, showSelected, value]
  );

  const { mutate, isLoading } = trpc.image.addTools.useMutation();
  const handleAddTools = async (multiple?: boolean) => {
    const ids = multiple ? imageIds : [image.id ?? 0];
    const payload = ids.reduce<{ imageId: number; toolId: number }[]>(
      (acc, imageId) => [...acc, ...value.map((toolId) => ({ imageId, toolId }))],
      []
    );
    await mutate(
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
          const newTools = value.map((toolId) => {
            const tool = tools.find((x) => x.id === toolId);
            return {
              id: toolId,
              name: tool?.name ?? '',
              icon: tool?.icon,
              notes: null,
            } as PostEditImageDetail['tools'][number];
          });
          image.tools = [
            ...image.tools,
            ...newTools.filter((x) => image.tools.findIndex((y) => y.id === x.id) === -1),
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
      loading={loadingTools}
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
            <Button size="compact-md" disabled={isLoading} onClick={() => handleAddTools()}>
              Add
            </Button>
            {imageCount > 1 && (
              <Button
                className="text-sm"
                variant="default"
                size="compact-md"
                disabled={isLoading}
                onClick={() => handleAddTools(true)}
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
