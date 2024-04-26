import {
  Button,
  Checkbox,
  Divider,
  Input,
  Popover,
  ScrollArea,
  Text,
  UnstyledButton,
  createStyles,
} from '@mantine/core';
import React, { useState, useMemo, useRef } from 'react';
import { PostEditImageDetail, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { trpc } from '~/utils/trpc';
import { Combobox } from '@headlessui/react';
import { isDefined } from '~/utils/type-guards';
import { ToolModel } from '~/server/services/tool.service';
import { getDisplayName } from '~/utils/string-helpers';

export function ImageToolsPopover({
  children,
  image,
}: {
  children: React.ReactElement;
  image: PostEditImageDetail;
}) {
  const { classes } = useStyles();
  const { data: tools = [] } = trpc.tool.getAll.useQuery();
  const [updateImage, imageCount, imageIds] = usePostEditStore((state) => [
    state.updateImage,
    state.images.length,
    state.images.map((x) => (x.type === 'added' ? x.data.id : undefined)).filter(isDefined),
  ]);
  const [search, setSearch] = useState('');
  const [showSelected, setShowSelected] = useState(false);
  const [value, setValue] = useState<number[]>(() => []);
  // const test = useMemo(() => {})
  const groups = useMemo(() => {
    const grouped = tools.reduce<Record<string, ToolModel[]>>((acc, tool) => {
      if (!acc[tool.type]) acc[tool.type] = [];
      acc[tool.type].push(tool);
      return acc;
    }, {});
    return Object.entries(grouped);
  }, [tools]);

  const filtered = groups.map(([key, tools]) => {
    return [
      key,
      tools.filter((x) => {
        if (image.tools.findIndex((tool) => tool.id === x.id) > -1) return false;
        if (showSelected) return value.includes(x.id);
        if (search.length) return x.name.toLowerCase().includes(search);
        return true;
      }),
    ] as [string, ToolModel[]];
  });
  const nothingFound = Object.values(filtered).every(([key, tools]) => !tools.length);

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
          handleSetValue([]);
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

  function handleSetValue(value: number[]) {
    setValue(value);
    if (!value.length) setShowSelected(false);
  }

  function handleClose() {
    setTimeout(() => handleSetValue([]), 300);
  }

  return (
    <Popover position="bottom-start" withinPortal onClose={handleClose} trapFocus>
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown className="p-0 rounded-lg">
        <div className="flex flex-col">
          <Combobox
            value={value}
            onChange={handleSetValue}
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
              auto
            />
            <Divider />
            <ScrollArea.Autosize
              maxHeight={250}
              type="always"
              offsetScrollbars
              classNames={classes}
            >
              {nothingFound ? (
                <Text align="center" className="p-2" color="dimmed">
                  Nothing found
                </Text>
              ) : (
                <div className="p-2 pr-0">
                  <Combobox.Options static>
                    {filtered.map(([key, tools]) => (
                      <React.Fragment key={key}>
                        {!!tools.length && (
                          <Divider
                            label={
                              <Text
                                component="li"
                                color="dimmed"
                                className="py-1 px-2 font-semibold text-sm"
                              >
                                {getDisplayName(key)}
                              </Text>
                            }
                          />
                        )}
                        {tools.map((tool) => (
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
                                <Checkbox checked={selected} readOnly tabIndex={-1} />
                              </>
                            )}
                          </Combobox.Option>
                        ))}
                      </React.Fragment>
                    ))}
                  </Combobox.Options>
                </div>
              )}
            </ScrollArea.Autosize>
          </Combobox>
          {!!value.length && (
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
          )}
        </div>
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
