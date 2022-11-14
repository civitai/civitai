import {
  useSensors,
  useSensor,
  PointerSensor,
  KeyboardSensor,
  DndContext,
  closestCenter,
  DragEndEvent,
  UniqueIdentifier,
  DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates, SortableContext } from '@dnd-kit/sortable';
import {
  Checkbox,
  createStyles,
  Group,
  Input,
  InputWrapperProps,
  RingProgress,
  Text,
  Stack,
  Title,
  Button,
} from '@mantine/core';
import { FileWithPath, Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useDidUpdate, useListState } from '@mantine/hooks';
import { IconGripVertical } from '@tabler/icons';
import { useEffect, useState } from 'react';
import { blurHashImage, loadImage } from '../../utils/blurhash';
import produce from 'immer';
import { ImageUploadPreview } from '~/components/ImageUpload/ImageUploadPreview';
import { SortableImage } from './SortableItem';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import useIsClient from '~/hooks/useIsClient';

type Props = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  hasPrimaryImage?: boolean;
  max?: number;
  value?: Array<CustomFile>;
  onChange?: (value: Array<CustomFile>) => void;
};

//TODO File Safety: Limit to the specific file extensions we want to allow
export function ImageUpload({
  value = [],
  onChange,
  label,
  max = 10,
  hasPrimaryImage,
  withAsterisk,
  ...inputWrapperProps
}: Props) {
  const { classes } = useStyles();
  const isClient = useIsClient();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const { uploadToCF, files: imageFiles } = useCFImageUpload();
  const [files, filesHandlers] = useListState<CustomFile>(
    value.map((file, index) => ({ ...file, index: index + 1 }))
  );
  const [activeId, setActiveId] = useState<UniqueIdentifier>();
  const [selectedFiles, selectedFilesHandlers] = useListState<string>([]);

  useEffect(() => {
    // clear any remaining urls when unmounting
    return () => files.forEach((file) => URL.revokeObjectURL(file.url));
  }, [files]);

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    const toUpload = await Promise.all(
      droppedFiles.map(async (file) => {
        const src = URL.createObjectURL(file);
        const img = await loadImage(src);
        const hashResult = blurHashImage(img);
        return {
          name: file.name,
          url: src,
          file,
          ...hashResult,
        };
      })
    );
    filesHandlers.setState((current) => [...current, ...toUpload]);

    await Promise.all(
      toUpload.map(async (image) => {
        const { id } = await uploadToCF(image.file);
        filesHandlers.setState(
          produce((current) => {
            const index = current.findIndex((item) => item.file === image.file);
            if (index === -1) return;
            current[index].url = id;
            current[index].file = undefined;
          })
        );
        URL.revokeObjectURL(image.url);
      })
    );
  };

  useDidUpdate(() => {
    if (files) onChange?.(files);
    // don't disable the eslint-disable
  }, [files]); //eslint-disable-line

  const selectedFilesCount = selectedFiles.length;
  const allFilesSelected = selectedFiles.length === files.length && files.length !== 0;
  const partialFilesSelected = !allFilesSelected && selectedFiles.length !== 0;
  const hasSelectedFile = selectedFilesCount > 0;

  const alternateLabel = (
    <Group sx={{ justifyContent: 'space-between', flex: 1 }}>
      <Group align="center">
        <Checkbox
          sx={{ display: 'flex' }}
          checked={allFilesSelected}
          indeterminate={partialFilesSelected}
          onChange={() =>
            selectedFilesHandlers.setState(allFilesSelected ? [] : files.map((file) => file.url))
          }
        />
        <Title order={5}>{`${selectedFilesCount} ${
          selectedFilesCount > 1 ? 'files' : 'file '
        } selected`}</Title>
      </Group>
      <Button
        color="red"
        variant="subtle"
        size="xs"
        compact
        onClick={() => {
          filesHandlers.setState((items) =>
            items
              .filter((item) => !selectedFiles.includes(item.url))
              .map((file, index) => ({ ...file, index: index + 1 }))
          );
          selectedFilesHandlers.setState([]);
        }}
      >
        {selectedFilesCount > 1 ? 'Delete Files' : 'Delete File'}
      </Button>
    </Group>
  );

  return (
    <div>
      <Input.Wrapper
        label={hasSelectedFile ? alternateLabel : label}
        labelProps={hasSelectedFile ? { className: classes.fullWidth } : undefined}
        withAsterisk={hasSelectedFile ? false : withAsterisk}
        {...inputWrapperProps}
      >
        <Stack>
          <Dropzone
            accept={IMAGE_MIME_TYPE}
            onDrop={handleDrop}
            maxFiles={max}
            styles={(theme) => ({
              root: !!inputWrapperProps.error
                ? {
                    borderColor: theme.colors.red[6],
                    marginBottom: theme.spacing.xs / 2,
                  }
                : undefined,
            })}
          >
            <Text align="center">Drop images here</Text>
          </Dropzone>

          {isClient && (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              onDragStart={handleDragStart}
              onDragCancel={handleDragCancel}
            >
              <SortableContext items={files.map((x) => x.url)} disabled={hasSelectedFile}>
                {files.length > 0 ? (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `repeat(3, 1fr)`,
                      gridGap: 10,
                      padding: 10,
                    }}
                  >
                    {files.map((image, index) => {
                      const match = imageFiles.find((file) => image.file === file.file);
                      const { progress } = match ?? { progress: 0 };
                      const showLoading = match && progress < 100 && !!image.file;
                      const selected = selectedFiles.includes(image.url);

                      return (
                        <SortableImage key={image.url} id={image.url} disabled={hasSelectedFile}>
                          <ImageUploadPreview
                            image={image}
                            isPrimary={hasPrimaryImage && index === 0}
                          >
                            {showLoading && (
                              <RingProgress
                                sx={{ position: 'absolute' }}
                                sections={[{ value: progress, color: 'blue' }]}
                                size={48}
                                thickness={4}
                                roundCaps
                              />
                            )}
                            <Group align="center">
                              {!hasSelectedFile && (
                                <Group>
                                  <IconGripVertical
                                    size={24}
                                    stroke={1.5}
                                    className={classes.draggableIcon}
                                    color="white"
                                  />
                                </Group>
                              )}
                              <Checkbox
                                className={classes.checkbox}
                                size="xs"
                                checked={selected}
                                onChange={() => {
                                  const index = selectedFiles.indexOf(image.url);
                                  index === -1
                                    ? selectedFilesHandlers.append(image.url)
                                    : selectedFilesHandlers.remove(index);
                                }}
                              />
                            </Group>
                          </ImageUploadPreview>
                        </SortableImage>
                      );
                    })}
                  </div>
                ) : null}
              </SortableContext>
              {hasPrimaryImage && (
                <DragOverlay adjustScale={true}>
                  {activeId && (
                    <ImageUploadPreview
                      isPrimary={files.findIndex((file) => file.url === activeId) === 0}
                      image={files.find((file) => file.url === activeId)}
                    />
                  )}
                </DragOverlay>
              )}
            </DndContext>
          )}
        </Stack>
      </Input.Wrapper>
    </div>
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      filesHandlers.setState((items) => {
        const ids = items.map(({ url }): UniqueIdentifier => url);
        const oldIndex = ids.indexOf(active.id);
        const newIndex = ids.indexOf(over.id);
        const sorted = arrayMove(items, oldIndex, newIndex);
        return sorted;
      });
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id);
  }

  function handleDragCancel() {
    setActiveId(undefined);
  }
}

const useStyles = createStyles((theme, _params, getRef) => ({
  sortItem: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',

    [`&:hover .${getRef('actionsGroup')}`]: {
      opacity: 1,
      transition: 'all .1s ease',
    },
  },

  draggableIcon: {
    position: 'absolute',
    top: '4px',
    right: 0,
  },

  checkbox: {
    position: 'absolute',
    top: '4px',
    left: '4px',
  },

  actionsGroup: {
    ref: getRef('actionsGroup'),
    opacity: 0,
    position: 'absolute',
    background: theme.fn.rgba(theme.colors.dark[9], 0.4),
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    top: 0,
    left: 0,
  },

  selected: {
    [`.${getRef('actionsGroup')}`]: {
      opacity: 1,
      transition: 'all .1s ease',
      background: theme.fn.rgba(theme.colors.gray[0], 0.4),
    },
  },

  fullWidth: {
    width: '100%',
  },
}));
