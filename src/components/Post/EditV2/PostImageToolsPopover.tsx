import {
  Button,
  Checkbox,
  Divider,
  Input,
  Popover,
  ScrollArea,
  Text,
  createStyles,
} from '@mantine/core';
import React, { useState, useMemo } from 'react';
import { PostEditImageDetail, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { trpc } from '~/utils/trpc';
import { Combobox } from '@headlessui/react';
import { isDefined } from '~/utils/type-guards';

export function ImageToolsPopover({
  children,
  image,
}: {
  children: React.ReactElement;
  image: PostEditImageDetail;
}) {
  trpc.tool.getAll.useQuery();

  return (
    <Popover position="bottom-start">
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown className="p-0 rounded-lg">
        <InnerContent image={image} />
      </Popover.Dropdown>
    </Popover>
  );
}

const useStyles = createStyles(() => ({
  viewport: { paddingBottom: 0 },
  scrollbar: {
    '&[data-orientation="horizontal"]': { display: 'none' },
  },
}));

function InnerContent({ image }: { image: PostEditImageDetail }) {
  const { classes } = useStyles();
  const { data: tools = [] } = trpc.tool.getAll.useQuery();
  const [updateImage, imageCount, imageIds] = usePostEditStore((state) => [
    state.updateImage,
    state.images.length,
    state.images.map((x) => (x.type === 'added' ? x.data.id : undefined)).filter(isDefined),
  ]);
  const [search, setSearch] = useState('');
  const [showSelected, setShowSelected] = useState(false);
  // NOTE: not sure why, but the combobox doesn't like having an empty array as the initial value
  const [_value, setValue] = useState<number[]>([-1]);
  const value = useMemo(() => [..._value.filter((x) => x !== -1)], [_value]);

  const filtered = tools.filter((x) => {
    if (image.tools.findIndex((tool) => tool.id === x.id) > -1) return false;
    if (showSelected) return value.includes(x.id);
    if (search.length) return x.name.toLowerCase().includes(search);
    return true;
  });

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
          setValue([-1]);
          setShowSelected(false);
          if (!image.id) return;
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
        },
      }
    );
  };

  return (
    <div className="flex flex-col">
      <Combobox
        value={_value}
        onChange={setValue}
        // @ts-ignore eslint-disable-next-line
        multiple
      >
        <Combobox.Input
          as={Input}
          onChange={(e) => setSearch(e.target.value.toLowerCase())}
          displayValue={() => search}
          // @ts-ignore eslint-disable-next-line
          placeholder="search..."
          className="m-2"
          radius="xl"
        />
        <Divider />
        <ScrollArea.Autosize maxHeight={250} type="always" offsetScrollbars classNames={classes}>
          <div className="p-2">
            <Combobox.Options static>
              {filtered.map((tool) => (
                <Combobox.Option
                  key={tool.id}
                  value={tool.id}
                  className={({ active }) =>
                    `flex justify-between items-center gap-3 py-1 px-2 cursor-pointer rounded ${
                      active ? 'bg-gray-1 dark:bg-dark-5' : ''
                    }`
                  }
                >
                  {({ selected }) => (
                    <>
                      <span>{tool.name}</span>
                      <Checkbox checked={selected} readOnly />
                    </>
                  )}
                </Combobox.Option>
              ))}
            </Combobox.Options>
          </div>
        </ScrollArea.Autosize>
      </Combobox>
      {!!value.length && (
        <div className="p-2 pt-0 flex flex-col gap-2">
          <div>
            <Divider />
            <Text
              variant="link"
              align="center"
              className="cursor-pointer m-1"
              onClick={() => setShowSelected((b) => !b)}
            >
              {!showSelected ? `Show ${value.length} selected` : `Show all`}
            </Text>
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
      )}
    </div>
  );
}
