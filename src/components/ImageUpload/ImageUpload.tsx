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
import { useListState } from '@mantine/hooks';
import { IconGripVertical } from '@tabler/icons';
import { useEffect, useState } from 'react';
import { useS3Upload } from '~/hooks/use-s3-upload';
import { blurHashImage, loadImage } from '../../utils/blurhash';
import produce from 'immer';
import { ImagePreview } from '~/components/ImageUpload/ImagePreview';
import { SortableImage } from './SortableItem';

type Props = InputWrapperProps & {
  value: Array<CustomFile>;
  onChange: (value: Array<CustomFile>) => void;
};

const MAX_FILE_UPLOAD = 10;

export function ImageUpload({ value = [], onChange, label, ...inputWrapperProps }: Props) {
  const { classes, cx } = useStyles();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const { uploadToS3, files: imageFiles } = useS3Upload();
  const [files, filesHandlers] = useListState<CustomFile>(
    value.map((file, index) => ({ ...file, index: index + 1 }))
  );
  const [activeId, setActiveId] = useState<UniqueIdentifier>();
  const [selectedFiles, selectedFilesHandlers] = useListState<string>([]);

  useEffect(() => {
    // clear any remaining urls when unmounting
    return () => files.forEach((file) => URL.revokeObjectURL(file.url));
  }, [files]);

  const handlDrop = async (droppedFiles: FileWithPath[]) => {
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
        const { url } = await uploadToS3(image.file);
        filesHandlers.setState(
          produce((current) => {
            const index = current.findIndex((item) => item.file === image.file);
            if (index === -1) return;
            current[index].url = url;
            current[index].file = undefined;
          })
        );
        URL.revokeObjectURL(image.url);
      })
    );
  };

  useEffect(() => {
    onChange(files);
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
    <>
      {hasSelectedFile ? alternateLabel : <Text>{label}</Text>}
      <Input.Wrapper {...inputWrapperProps}>
        <Stack>
          <Dropzone
            accept={IMAGE_MIME_TYPE}
            onDrop={handlDrop}
            maxFiles={10}
            styles={(theme) => ({
              root: {
                borderColor: !!inputWrapperProps.error ? theme.colors.red[6] : undefined,
              },
            })}
          >
            <Text align="center">Drop images here</Text>
          </Dropzone>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            onDragStart={handleDragStart}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={files.map((x) => x.url)} disabled={hasSelectedFile}>
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
                      <ImagePreview index={index} image={image}>
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
                      </ImagePreview>
                    </SortableImage>
                  );
                })}
              </div>
            </SortableContext>
            <DragOverlay adjustScale={true}>
              {activeId && (
                <ImagePreview
                  index={files.findIndex((file) => file.url === activeId)}
                  image={files.find((file) => file.url === activeId)}
                ></ImagePreview>
              )}
            </DragOverlay>
          </DndContext>
        </Stack>
      </Input.Wrapper>
    </>
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
}));
