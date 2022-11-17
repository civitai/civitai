import {
  useSensors,
  useSensor,
  PointerSensor,
  DndContext,
  closestCenter,
  DragEndEvent,
  UniqueIdentifier,
  DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import { arrayMove, SortableContext } from '@dnd-kit/sortable';
import {
  createStyles,
  Group,
  Input,
  InputWrapperProps,
  RingProgress,
  Text,
  Stack,
  Title,
  Button,
  ActionIcon,
  Popover,
  Textarea,
  NumberInput,
  Grid,
  Select,
} from '@mantine/core';
import { FileWithPath, Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useDidUpdate, useListState } from '@mantine/hooks';
import { IconPencil, IconTrash } from '@tabler/icons';
import { cloneElement, useState } from 'react';
import { blurHashImage, loadImage } from '../../utils/blurhash';
import { ImageUploadPreview } from '~/components/ImageUpload/ImageUploadPreview';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import useIsClient from '~/hooks/useIsClient';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getMetadata } from '~/utils/image-metadata';

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
  ...inputWrapperProps
}: Props) {
  const { classes } = useStyles();
  const isClient = useIsClient();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
    // useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const { uploadToCF, files: imageFiles } = useCFImageUpload();
  const [files, filesHandlers] = useListState<CustomFile>(value);
  const [activeId, setActiveId] = useState<UniqueIdentifier>();

  // Disabled this because it seemed to cause state loop...
  // useDidUpdate(() => {
  //   const shouldReset = !isEqual(value, files);
  //   console.log('did update');
  //   if (shouldReset) filesHandlers.setState(value);
  // }, [value]);

  useDidUpdate(() => {
    if (files) onChange?.(files);
    // don't disable the eslint-disable
  }, [files]); //eslint-disable-line

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    const toUpload = await Promise.all(
      droppedFiles.map(async (file) => {
        const src = URL.createObjectURL(file);
        const meta = await getMetadata(file);
        const img = await loadImage(src);
        const hashResult = blurHashImage(img);
        return {
          name: file.name,
          url: src,
          previewUrl: src,
          file,
          meta,
          ...hashResult,
        };
      })
    );

    filesHandlers.setState((current) => [...current, ...toUpload]);

    const uploads = await Promise.all(
      toUpload.map(async ({ url, file, previewUrl }) => {
        const { id } = await uploadToCF(file);
        return { url, file, id, previewUrl };
      })
    );

    filesHandlers.setState((states) =>
      states.map((state) => {
        const matchingUpload = uploads.find((x) => x.file == state.file);
        if (!matchingUpload) return state;
        return {
          ...state,
          url: matchingUpload.id,
          onLoad: () => URL.revokeObjectURL(matchingUpload.previewUrl),
          file: null,
        };
      })
    );
  };

  return (
    <div>
      <Input.Wrapper label={label} {...inputWrapperProps}>
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
              <SortableContext items={files.map((x) => x.url)}>
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

                      return (
                        // <SortableImage key={image.url} id={image.url} disabled={hasSelectedFile}>
                        <ImageUploadPreview
                          key={image.url}
                          image={image}
                          isPrimary={hasPrimaryImage && index === 0}
                          // disabled={hasSelectedFile}
                          id={image.url}
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
                          <Group
                            className={classes.actionsGroup}
                            align="center"
                            position="right"
                            p={4}
                            spacing={4}
                          >
                            <ImageMetaPopover
                              meta={image.meta}
                              onSubmit={(meta) => filesHandlers.setItem(index, { ...image, meta })}
                            >
                              <ActionIcon
                                variant="outline"
                                color={
                                  image.meta && Object.keys(image.meta).length
                                    ? 'primary'
                                    : undefined
                                }
                              >
                                <IconPencil />
                              </ActionIcon>
                            </ImageMetaPopover>
                            <ActionIcon
                              color="red"
                              variant="outline"
                              onClick={() =>
                                filesHandlers.setState((state) => [
                                  ...state.filter((x) => x.url !== image.url),
                                ])
                              }
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Group>
                        </ImageUploadPreview>
                        // </SortableImage>
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
                      id="selected"
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

function ImageMetaPopover({
  children,
  meta,
  onSubmit,
}: {
  children: React.ReactElement;
  meta?: ImageMetaProps | null;
  onSubmit?: (meta: ImageMetaProps | null) => void;
}) {
  const [opened, setOpened] = useState(false);

  const [prompt, setPrompt] = useState<string | undefined>(meta?.prompt);
  const [negativePrompt, setNegativePrompt] = useState<string | undefined>(meta?.negativePrompt);
  const [cfgScale, setCfgScale] = useState<number | undefined>(meta?.cfgScale);
  const [steps, setSteps] = useState<number | undefined>(meta?.steps);
  const [sampler, setSampler] = useState<string | undefined>(meta?.sampler);
  const [seed, setSeed] = useState<number | undefined>(meta?.seed);

  const handleClose = () => {
    setPrompt(meta?.prompt);
    setNegativePrompt(meta?.negativePrompt);
    setCfgScale(meta?.cfgScale);
    setSteps(meta?.steps);
    setSampler(meta?.sampler);
    setSeed(meta?.seed);
    setOpened((v) => !v);
  };

  const handleSubmit = () => {
    const newMeta = { ...meta, prompt, negativePrompt, cfgScale, steps, sampler, seed };
    const keys = Object.keys(newMeta) as Array<keyof typeof newMeta>;
    const toSubmit = keys.reduce<ImageMetaProps>((acc, key) => {
      if (newMeta[key]) return { ...acc, [key]: newMeta[key] };
      return acc;
    }, {});
    onSubmit?.(Object.keys(toSubmit).length ? toSubmit : null);
    setOpened(false);
  };

  return (
    <Popover opened={opened} onClose={handleClose} withArrow withinPortal width={400}>
      <Popover.Target>{cloneElement(children, { onClick: handleClose })}</Popover.Target>
      <Popover.Dropdown>
        <Title order={4}>Generation details</Title>
        <Grid gutter="xs">
          <Grid.Col span={12}>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              label="Prompt"
              autosize
              maxRows={3}
            />
          </Grid.Col>
          <Grid.Col span={12}>
            <Textarea
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              label="Negative prompt"
              autosize
              maxRows={3}
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <NumberInput
              value={cfgScale}
              onChange={(number) => setCfgScale(number)}
              label="Guidance scale"
              min={0}
              max={30}
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <NumberInput value={steps} onChange={(value) => setSteps(value)} label="Steps" />
          </Grid.Col>
          <Grid.Col span={6}>
            <Select
              clearable
              searchable
              data={[
                'Euler a',
                'Euler',
                'LMS',
                'Heun',
                'DPM2',
                'DPM2 a',
                'DPM fast',
                'DPM adaptive',
                'LMS Karras',
                'DPM2 Karras',
                'DPM2 a Karras',
                'DDIM',
                'PLMS',
              ]}
              value={sampler}
              onChange={(value) => setSampler(value ?? undefined)}
              label="Sampler"
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <NumberInput value={seed} onChange={(value) => setSeed(value)} label="Seed" />
          </Grid.Col>
        </Grid>
        <Button mt="xs" fullWidth onClick={() => handleSubmit()}>
          Save
        </Button>
      </Popover.Dropdown>
    </Popover>
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
    position: 'absolute',
    background: theme.fn.rgba(theme.colors.dark[9], 0.6),
    borderBottomLeftRadius: theme.radius.sm,
    top: 0,
    right: 0,
  },

  selected: {
    [`.${getRef('actionsGroup')}`]: {
      opacity: 1,
      transition: 'all .1s ease',
      background: theme.fn.rgba(theme.colors.gray[0], 0.4),
    },
  },

  meta: {
    position: 'absolute',
    bottom: '4px',
    right: '4px',
  },

  fullWidth: {
    width: '100%',
  },
}));
