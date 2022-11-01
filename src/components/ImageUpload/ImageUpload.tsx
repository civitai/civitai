import { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import {
  Checkbox,
  createStyles,
  Group,
  Input,
  InputWrapperProps,
  Paper,
  RingProgress,
  Text,
  Image,
  Stack,
  Title,
  Button,
} from '@mantine/core';
import { FileWithPath, Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useListState } from '@mantine/hooks';
import { IconZoomIn, IconGripVertical } from '@tabler/icons';
import { useEffect } from 'react';
import { useS3Upload } from '~/hooks/use-s3-upload';
import { ImageUploadProps } from '~/server/validators/image/schema';
import { SortableGrid } from '../SortableGrid/SortableGrid';
import { blurHashImage } from '../../utils/blurhash';

type CustomFile = ImageUploadProps & { file?: FileWithPath; index: number };

type Props = InputWrapperProps & {
  value: Array<CustomFile>;
  onChange: (value: Array<CustomFile>) => void;
};

export function ImageUpload({ value = [], onChange, ...inputWrapperProps }: Props) {
  const { classes, cx } = useStyles();

  const { uploadToS3, files: imageFiles } = useS3Upload();
  const [files, filesHandlers] = useListState<CustomFile>(
    value.map((file, index) => ({ ...file, index: index + 1 }))
  );
  const [selectedFiles, selectedFilesHandlers] = useListState<string>([]);

  useEffect(() => {
    // clear any remaining urls when unmounting
    return () => files.forEach((file) => URL.revokeObjectURL(file.url));
  }, [files]);

  const handlDrop = async (droppedFiles: FileWithPath[]) => {
    filesHandlers.setState((current) =>
      [
        ...current,
        ...droppedFiles.map((file) => ({
          name: file.name,
          url: URL.createObjectURL(file),
          file,
        })),
      ].map((file, index) => ({ ...file, index: index + 1 }))
    );
  };

  useEffect(() => {
    onChange(files);
  }, [files]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      filesHandlers.setState((items) => {
        const indices = items.map(({ index }) => index);
        const oldIndex = indices.indexOf(active.id as number);
        const newIndex = indices.indexOf(over.id as number);
        const sorted = arrayMove(items, oldIndex, newIndex);
        return sorted.map((image, index) => ({ ...image, index: index + 1 }));
      });
    }
  };

  const selectedFilesCount = selectedFiles.length;
  const allFilesSelected = selectedFiles.length === files.length && files.length !== 0;
  const partialFilesSelected = !allFilesSelected && selectedFiles.length !== 0;
  const hasSelectedFile = selectedFilesCount > 0;

  return (
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
        {hasSelectedFile && (
          <Group sx={{ justifyContent: 'space-between' }}>
            <Group align="center">
              <Checkbox
                sx={{ display: 'flex' }}
                checked={allFilesSelected}
                indeterminate={partialFilesSelected}
                onChange={() =>
                  selectedFilesHandlers.setState(
                    allFilesSelected ? [] : files.map((file) => file.url)
                  )
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
        )}

        <SortableGrid
          items={files}
          rowKey="index"
          onDragEnd={handleDragEnd}
          gridProps={{
            cols: 3,
            breakpoints: [{ maxWidth: 'sm', cols: 1 }],
          }}
          disabled={hasSelectedFile}
        >
          {(image, index) => {
            const match = imageFiles.find((file) => image.file === file.file);
            const { progress } = match ?? { progress: 0 };
            const showLoading = match && progress < 100 && !!image.file;
            const selected = selectedFiles.includes(image.url);

            return (
              <Paper
                className={cx({
                  [classes.sortItem]: !showLoading,
                  [classes.selected]: hasSelectedFile,
                })}
                radius="sm"
                sx={{
                  position: 'relative',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <Image
                  key={image.id}
                  src={image.url}
                  alt={image.name}
                  sx={showLoading ? { filter: 'blur(2px)' } : undefined}
                  onLoad={async (e) => {
                    if (image.file) {
                      const imgEl = e.target as HTMLImageElement;
                      const { file, ...restOfImage } = image;
                      const { url } = await uploadToS3(file, 'image');
                      const hashResult = blurHashImage(imgEl);
                      URL.revokeObjectURL(image.url);
                      filesHandlers.setItem(index, { ...restOfImage, ...hashResult, url });
                    }
                  }}
                  radius="sm"
                  fit="contain"
                />
                {showLoading && (
                  <RingProgress
                    sx={{ position: 'absolute' }}
                    sections={[{ value: progress, color: 'blue' }]}
                    size={48}
                    thickness={4}
                    roundCaps
                  />
                )}
                <Group align="center" className={classes.actionsGroup}>
                  {!hasSelectedFile ? (
                    <Group>
                      {/* <IconZoomIn size={32} stroke={1.5} color="white" /> */}
                      <IconGripVertical
                        size={24}
                        stroke={1.5}
                        className={classes.draggableIcon}
                        color="white"
                      />
                    </Group>
                  ) : null}
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
              </Paper>
            );
          }}
        </SortableGrid>
      </Stack>
    </Input.Wrapper>
  );
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
