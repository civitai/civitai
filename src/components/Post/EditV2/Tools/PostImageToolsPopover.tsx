import { Button, Checkbox, Divider, Popover, Text, UnstyledButton } from '@mantine/core';
import React, { useState, useMemo } from 'react';
import { PostEditImageDetail, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { getDisplayName } from '~/utils/string-helpers';
import { AlwaysOpenCombobox } from '~/components/Combobox/AlwaysOpenComboBox';
import { ComboboxOption } from '~/components/Combobox/combobox.types';

export function ImageToolsPopover({
  children,
  image,
}: {
  children: React.ReactElement;
  image: PostEditImageDetail;
}) {
  const { data: tools = [] } = trpc.tool.getAll.useQuery();
  const [updateImage, imageCount, imageIds] = usePostEditStore((state) => [
    state.updateImage,
    state.images.length,
    state.images.map((x) => (x.type === 'added' ? x.data.id : undefined)).filter(isDefined),
  ]);
  const [showSelected, setShowSelected] = useState(false);
  const [value, setValue] = useState<number[]>(() => []);
  const [opened, setOpened] = useState(false);

  const options: ComboboxOption[] = useMemo(
    () =>
      tools
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
  const handleAddTools = (multiple?: boolean) => {
    const ids = multiple ? imageIds : [image.id ?? 0];
    const payload = ids.reduce<{ imageId: number; toolId: number }[]>(
      (acc, imageId) => [...acc, ...value.map((toolId) => ({ imageId, toolId }))],
      []
    );
    mutate(
      { data: payload },
      {
        onSuccess: () => {
          setOpened(false);
          handleClose(ids);
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
    <Popover
      position="bottom-start"
      withinPortal
      onClose={handleClose}
      trapFocus
      opened={opened}
      onChange={setOpened}
    >
      <Popover.Target>
        {React.cloneElement(children, { onClick: () => setOpened((o) => !o) })}
      </Popover.Target>
      <Popover.Dropdown className="p-0 rounded-lg">
        <AlwaysOpenCombobox
          value={value}
          onChange={handleSetValue}
          options={options}
          renderOption={({ selected, label }) => (
            <>
              <span>{label}</span>
              <Checkbox checked={selected} readOnly tabIndex={-1} />
            </>
          )}
          footer={
            !!value.length && (
              <div className="p-2 pt-0 flex flex-col gap-2">
                <div>
                  <Divider />
                  <div className="flex justify-center">
                    <UnstyledButton
                      className="cursor-pointer m-1"
                      onClick={() => setShowSelected((b) => !b)}
                    >
                      <Text variant="link" align="center">
                        {!showSelected ? `Show ${value.length} selected` : `Show all`}
                      </Text>
                    </UnstyledButton>
                  </div>
                  <Divider />
                </div>
                <Button compact size="md" disabled={isLoading} onClick={() => handleAddTools()}>
                  Add
                </Button>
                {imageCount > 1 && (
                  <Button
                    className="text-sm"
                    variant="default"
                    compact
                    size="md"
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
      </Popover.Dropdown>
    </Popover>
  );
}
