import { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import {
  Button,
  Checkbox,
  createStyles,
  Group,
  Image,
  Paper,
  RingProgress,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { Dropzone, FileWithPath, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useListState } from '@mantine/hooks';
import { IconZoomIn, IconGripVertical } from '@tabler/icons';
import React, { useEffect } from 'react';
import { SortableGrid } from '~/components/SortableGrid/SortableGrid';
import { useS3Upload } from '~/hooks/use-s3-upload';

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

export function FileDrop({
  title,
  errors,
  files: initialFiles = [],
  onDrop,
  onDragEnd,
  onDeleteFiles,
}: Props) {
  const { classes, cx } = useStyles();
  const [files, filesHandlers] = useListState<CustomFile>(initialFiles);
  const [selectedFiles, selectedFilesHandlers] = useListState<string>([]);

  const { uploadToS3, files: imageFiles } = useS3Upload();

  const handleOnDrop = async (droppedFiles: FileWithPath[]) => {
    filesHandlers.setState((current) => [
      ...current,
      ...droppedFiles.map((file) => ({
        // TODO: revisit unique number generator if it's giving issues
        id: Math.floor((Date.now() * Math.random()) / 1000),
        name: file.name,
        url: URL.createObjectURL(file),
        file,
      })),
    ]);

    const uploadedImages = await Promise.all(
      droppedFiles.map(async (file) => {
        const { url } = await uploadToS3(file, 'image');

        filesHandlers.setState((items) => {
          const currentItem = items.find((item) => item.file === file);
          if (!currentItem) return items;

          currentItem.url = url;
          return items.filter((item) => item !== currentItem).concat(currentItem);
        });

        return { url, name: file.name };
      })
    );

    onDrop(uploadedImages);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (active.id !== over?.id) {
      filesHandlers.setState((items) => {
        const ids = items.map(({ id }) => id);
        const oldIndex = ids.indexOf(active.id as number);
        const newIndex = ids.indexOf(over?.id as number);
        const sorted = arrayMove(items, oldIndex, newIndex);

        onDragEnd?.(sorted);
        return sorted;
      });
    }
  };

  const renderPreview = (image: CustomFile) => {
    const match = imageFiles.find((file) => image.file === file.file);
    const { progress } = match ?? { progress: 0 };
    const showLoading = match && progress < 100;
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
          onLoad={() => URL.revokeObjectURL(image.url)}
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
              <IconZoomIn size={32} stroke={1.5} color="white" />
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

              if (index !== -1 && selected) selectedFilesHandlers.remove(index);
              else selectedFilesHandlers.append(image.url);
            }}
          />
        </Group>
      </Paper>
    );
  };

  useEffect(() => {
    // clear any remaining urls when unmounting
    return () => files.forEach((file) => URL.revokeObjectURL(file.url));
  }, [files]);

  const selectedFilesCount = selectedFiles.length;
  const allFilesSelected = selectedFiles.length === files.length && files.length !== 0;
  const partialFilesSelected = !allFilesSelected && selectedFiles.length !== 0;
  const hasSelectedFile = selectedFilesCount > 0;

  return (
    <Stack>
      <Group sx={{ justifyContent: 'space-between' }}>
        {hasSelectedFile ? (
          <>
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
                onDeleteFiles(selectedFiles);
                filesHandlers.setState((items) =>
                  items.filter((item) => !selectedFiles.includes(item.url))
                );
                selectedFilesHandlers.setState([]);
              }}
            >
              {selectedFilesCount > 1 ? 'Delete Files' : 'Delete File'}
            </Button>
          </>
        ) : title ? (
          <Title order={5}>{title}</Title>
        ) : null}
      </Group>
      <Dropzone
        accept={IMAGE_MIME_TYPE}
        onDrop={handleOnDrop}
        maxFiles={10}
        styles={(theme) => ({
          root: {
            borderColor: !!errors?.length ? theme.colors.red[6] : undefined,
          },
        })}
      >
        <Text align="center">Drop images here</Text>
      </Dropzone>
      {errors ? (
        <Text color="red" size="xs">
          {errors}
        </Text>
      ) : null}
      <SortableGrid
        items={files}
        onDragEnd={handleDragEnd}
        gridProps={{
          cols: 3,
          breakpoints: [{ maxWidth: 'sm', cols: 1 }],
        }}
        disabled={hasSelectedFile}
      >
        {renderPreview}
      </SortableGrid>
    </Stack>
  );
}

type Props = {
  onDrop: (files: Array<{ name: string; url: string }>) => void;
  onDeleteFiles: (fileIds: string[]) => void;
  title?: string;
  onDragEnd?: (files: CustomFile[]) => void;
  errors?: string;
  files?: CustomFile[];
};
