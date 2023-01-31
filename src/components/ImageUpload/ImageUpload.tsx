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
  Tooltip,
  Loader,
  Center,
  Overlay,
} from '@mantine/core';
import { FileWithPath, Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useDidUpdate } from '@mantine/hooks';
import {
  IconExclamationCircle,
  IconPencil,
  IconPhoto,
  IconRating18Plus,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons';
import { cloneElement, useState } from 'react';
import { ImageUploadPreview } from '~/components/ImageUpload/ImageUploadPreview';
import useIsClient from '~/hooks/useIsClient';
import { ImageMetaProps } from '~/server/schema/image.schema';

import { useImageUpload } from '~/hooks/useImageUpload';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';

type Props = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  hasPrimaryImage?: boolean;
  max?: number;
  value?: Array<CustomFile>;
  onChange?: (value: Array<CustomFile>) => void;
  loading?: boolean;
  withMeta?: boolean;
  reset?: number;
};

//TODO File Safety: Limit to the specific file extensions we want to allow
export function ImageUpload({
  value = [],
  onChange,
  label,
  max = 10,
  hasPrimaryImage,
  loading = false,
  withMeta = true,
  reset = 0,
  ...inputWrapperProps
}: Props) {
  const { classes, theme, cx } = useStyles();
  const isClient = useIsClient();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const {
    files,
    filesHandler,
    removeImage,
    upload,
    canUseScanner,
    // isCompleted,
    // isUploading,
    // isProcessing,
    // hasErrors,
    // hasBlocked,
  } = useImageUpload({ max, value: Array.isArray(value) ? value : [] });
  const [activeId, setActiveId] = useState<UniqueIdentifier>();

  useDidUpdate(() => {
    if (reset > 0) filesHandler.setState(value);
  }, [reset]);

  useDidUpdate(() => {
    if (files) onChange?.(files);
    // don't disable the eslint-disable
  }, [files]); //eslint-disable-line

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    await upload(droppedFiles);
  };
  const dropzoneDisabled = files.length >= max;

  return (
    <Input.Wrapper
      label={label}
      description={`${files.length}/${max} uploaded files`}
      {...inputWrapperProps}
    >
      <Stack my={5}>
        <Dropzone
          accept={IMAGE_MIME_TYPE}
          onDrop={handleDrop}
          // maxFiles={max - files.length}
          className={cx({ [classes.disabled]: dropzoneDisabled })}
          styles={(theme) => ({
            root: !!inputWrapperProps.error
              ? {
                  borderColor: theme.colors.red[6],
                  marginBottom: theme.spacing.xs / 2,
                }
              : undefined,
          })}
          disabled={dropzoneDisabled}
          // loading={loading}
        >
          <Group position="center" spacing="xl" style={{ minHeight: 120, pointerEvents: 'none' }}>
            <Dropzone.Accept>
              <IconUpload
                size={50}
                stroke={1.5}
                color={theme.colors[theme.primaryColor][theme.colorScheme === 'dark' ? 4 : 6]}
              />
            </Dropzone.Accept>
            <Dropzone.Reject>
              <IconX
                size={50}
                stroke={1.5}
                color={theme.colors.red[theme.colorScheme === 'dark' ? 4 : 6]}
              />
            </Dropzone.Reject>
            <Dropzone.Idle>
              <IconPhoto size={50} stroke={1.5} />
            </Dropzone.Idle>

            <div>
              <Text size="xl" inline>
                Drag images here or click to select files
              </Text>
              <Text size="sm" color="dimmed" inline mt={7}>
                {max ? `Attach up to ${max} files` : 'Attach as many files as you like'}
              </Text>
            </div>
          </Group>
        </Dropzone>
        {!canUseScanner && files.length > 0 ? (
          <AlertWithIcon color="red" iconColor="red" icon={<IconExclamationCircle />}>
            The AI system that automatically identifies adult content cannot be run on your device.
            Please review the content of your images and ensure that any adult content is
            appropriately flagged.
          </AlertWithIcon>
        ) : null}

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
                  }}
                >
                  {files.map((image, index) => {
                    const showLoading = !!image.file || image.nsfw === undefined;

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
                          <Center
                            sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                          >
                            <Overlay blur={2} zIndex={10} color="#000" />
                            <Stack spacing="xs" sx={{ zIndex: 11 }} align="center">
                              <Loader size="lg" />
                              {image.status !== 'complete' && (
                                <Text weight={600}>{image.status}...</Text>
                              )}
                            </Stack>
                          </Center>
                        )}
                        <Group
                          className={classes.actionsGroup}
                          align="center"
                          position="right"
                          p={4}
                          spacing={4}
                        >
                          {!showLoading && (!image.status || image.status === 'complete') && (
                            <>
                              <Tooltip label="Toggle NSFW">
                                <ActionIcon
                                  color={image.nsfw ? 'red' : undefined}
                                  variant="filled"
                                  disabled={image.nsfw === undefined}
                                  onClick={() =>
                                    filesHandler.setItem(index, { ...image, nsfw: !image.nsfw })
                                  }
                                >
                                  <IconRating18Plus />
                                </ActionIcon>
                              </Tooltip>
                              {withMeta && (
                                <ImageMetaPopover
                                  meta={image.meta}
                                  onSubmit={(meta) =>
                                    filesHandler.setItem(index, { ...image, meta })
                                  }
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
                              )}
                            </>
                          )}
                          <ActionIcon
                            color="red"
                            variant="outline"
                            onClick={() => removeImage(image)}
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
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      filesHandler.setState((items) => {
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
                'DPM++ 2S a',
                'DPM++ 2M',
                'DPM++ SDE',
                'DPM fast',
                'DPM adaptive',
                'LMS Karras',
                'DPM2 Karras',
                'DPM2 a Karras',
                'DPM++ 2S a Karras',
                'DPM++ 2M Karras',
                'DPM++ SDE Karras',
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
    zIndex: 11,
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

  disabled: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    borderColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2],
    cursor: 'not-allowed',

    '& *': {
      color: theme.colorScheme === 'dark' ? theme.colors.dark[3] : theme.colors.gray[5],
    },
  },
}));
