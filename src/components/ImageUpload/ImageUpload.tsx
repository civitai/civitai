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
  Checkbox,
  createStyles,
  Group,
  Input,
  InputWrapperProps,
  Text,
  Stack,
  Button,
  ActionIcon,
  Popover,
  Textarea,
  NumberInput,
  Grid,
  Select,
  Tooltip,
  Loader,
  LoadingOverlay,
  Center,
  Overlay,
  Tabs,
  MultiSelect,
  Box,
  Alert,
  HoverCard,
} from '@mantine/core';
import { FileWithPath, Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useDidUpdate, useLocalStorage } from '@mantine/hooks';
import { TagTarget } from '@prisma/client';
import {
  IconPencil,
  IconPhoto,
  IconAlertTriangle,
  IconRating18Plus,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons';
import isEqual from 'lodash/isEqual';
import { cloneElement, useEffect, useMemo, useState } from 'react';

import { ImageUploadPreview } from '~/components/ImageUpload/ImageUploadPreview';
import useIsClient from '~/hooks/useIsClient';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { useImageUpload } from '~/hooks/useImageUpload';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { trpc } from '~/utils/trpc';
import { SimpleTag } from '~/server/selectors/tag.selector';
import { TagSort } from '~/server/common/enums';
import { getNeedsReview } from '~/utils/image-metadata';

type Props = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  hasPrimaryImage?: boolean;
  max?: number;
  value?: Array<CustomFile>;
  onChange?: (value: Array<CustomFile>) => void;
  loading?: boolean;
  withMeta?: boolean;
  reset?: number;
  extra?: React.ReactNode;
};

//TODO File Safety: Limit to the specific file extensions we want to allow
export function ImageUpload({
  value = [],
  onChange,
  label,
  extra,
  max = 10,
  hasPrimaryImage,
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
      description={
        <Group>
          <Text>{`${files.length}/${max} uploaded files`}</Text>
          {extra && <Box ml="auto">{extra}</Box>}
        </Group>
      }
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
                    return (
                      <UploadedImage
                        image={image}
                        index={index}
                        key={image.id ?? image.url}
                        removeImage={removeImage}
                        withMeta={withMeta}
                        filesHandler={filesHandler}
                        isPrimary={hasPrimaryImage === true && index === 0}
                      />
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

function UploadedImage({
  image,
  index,
  isPrimary,
  filesHandler,
  removeImage,
  withMeta,
}: {
  image: CustomFile;
  index: number;
  isPrimary: boolean;
  filesHandler: ReturnType<typeof useImageUpload>['filesHandler'];
  removeImage: ReturnType<typeof useImageUpload>['removeImage'];
  withMeta?: boolean;
}) {
  const isError = image.status === 'error';
  const isComplete = image.status === 'complete';
  const isBlocked = image.status === 'blocked';
  const showLoading = image.status && !isError && !isComplete && !isBlocked;
  const needsReview = useMemo(() => {
    if (image.id || image.status !== 'complete') return false;
    return getNeedsReview({ analysis: image.analysis, nsfw: image.nsfw });
  }, [image.id, image.analysis, image.nsfw, image.status]);

  return (
    <ImageUploadPreview image={image} isPrimary={isPrimary} id={image.url}>
      {showLoading && (
        <Center sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
          <Overlay blur={2} zIndex={10} color="#000" />
          <Stack spacing="xs" sx={{ zIndex: 11 }} align="center">
            <Loader size="lg" />
            {image.message && <Text weight={600}>{image.message}...</Text>}
          </Stack>
        </Center>
      )}
      {needsReview && (
        <HoverCard withinPortal withArrow position="top" width={250}>
          <HoverCard.Target>
            <Alert
              color="yellow"
              variant="filled"
              radius={0}
              p={4}
              sx={{
                position: 'absolute',
                bottom: 0,
                right: 0,
                left: 0,
                zIndex: 11,
              }}
            >
              <Group spacing={4} noWrap position="center">
                <IconAlertTriangle size={20} strokeWidth={2.5} />
                <Text sx={{ lineHeight: 1.1 }} weight={500}>
                  Will be reviewed
                </Text>
              </Group>
            </Alert>
          </HoverCard.Target>
          <HoverCard.Dropdown>
            <Text size="sm" weight={500}>
              Flagged by age detection
            </Text>
            <Text size="sm" sx={{ lineHeight: 1.2 }}>
              After submission this image will be reviewed by a moderator.
            </Text>
          </HoverCard.Dropdown>
        </HoverCard>
      )}
      <Group
        sx={(theme) => ({
          position: 'absolute',
          background: theme.fn.rgba(theme.colors.dark[9], 0.6),
          borderBottomLeftRadius: theme.radius.sm,
          top: 0,
          right: 0,
          zIndex: 11,
        })}
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
                variant={image.nsfw ? 'filled' : 'outline'}
                disabled={image.nsfw === undefined}
                onClick={() => filesHandler.setItem(index, { ...image, nsfw: !image.nsfw })}
              >
                <IconRating18Plus />
              </ActionIcon>
            </Tooltip>
            {withMeta && (
              <ImageMetaPopover
                meta={image.meta}
                tags={image.tags ?? []}
                nsfw={image.nsfw ?? false}
                onSubmit={(data) => filesHandler.setItem(index, { ...image, ...data })}
                onCopyTags={(tags) => {
                  filesHandler.apply((item) => ({ ...item, tags }));
                }}
              >
                <ActionIcon
                  variant="outline"
                  color={image.meta && Object.keys(image.meta).length ? 'primary' : undefined}
                >
                  <IconPencil />
                </ActionIcon>
              </ImageMetaPopover>
            )}
          </>
        )}
        <ActionIcon color="red" variant="outline" onClick={() => removeImage(image)}>
          <IconTrash size={16} />
        </ActionIcon>
      </Group>
    </ImageUploadPreview>
  );
}

function ImageMetaPopover({
  children,
  meta,
  tags,
  nsfw,
  onSubmit,
  onCopyTags,
}: {
  children: React.ReactElement;
  meta?: ImageMetaProps | null;
  onSubmit?: (data: { meta: ImageMetaProps | null; tags: SimpleTag[]; nsfw: boolean }) => void;
  tags: SimpleTag[];
  nsfw: boolean;
  onCopyTags?: (tags: SimpleTag[]) => void;
}) {
  const [opened, setOpened] = useState(false);

  const [prompt, setPrompt] = useState<string | undefined>(meta?.prompt);
  const [negativePrompt, setNegativePrompt] = useState<string | undefined>(meta?.negativePrompt);
  const [cfgScale, setCfgScale] = useState<number | undefined>(meta?.cfgScale);
  const [steps, setSteps] = useState<number | undefined>(meta?.steps);
  const [sampler, setSampler] = useState<string | undefined>(meta?.sampler);
  const [seed, setSeed] = useState<number | undefined>(meta?.seed);
  const [imageTags, setImageTags] = useState<SimpleTag[]>(tags);
  const [tab, setTab] = useLocalStorage<string | null>({
    key: 'image-meta-tab',
    defaultValue: 'tags',
  });
  const [imageNsfw, setImageNsfw] = useState(nsfw);

  const handleClose = () => {
    setPrompt(meta?.prompt);
    setNegativePrompt(meta?.negativePrompt);
    setCfgScale(meta?.cfgScale);
    setSteps(meta?.steps);
    setSampler(meta?.sampler);
    setSeed(meta?.seed);
    setImageTags(tags);
    setImageNsfw(nsfw);
    setOpened((v) => !v);
  };

  const handleSubmit = () => {
    const newMeta = { ...meta, prompt, negativePrompt, cfgScale, steps, sampler, seed };
    const keys = Object.keys(newMeta) as Array<keyof typeof newMeta>;
    const toSubmit = keys.reduce<ImageMetaProps>((acc, key) => {
      if (newMeta[key]) return { ...acc, [key]: newMeta[key] };
      return acc;
    }, {});
    onSubmit?.({
      meta: Object.keys(toSubmit).length ? toSubmit : null,
      tags: imageTags,
      nsfw: imageNsfw,
    });
    setOpened(false);
  };

  return (
    <Popover
      opened={opened}
      onClose={handleClose}
      position="bottom"
      withArrow
      withinPortal
      width={400}
    >
      <Popover.Target>{cloneElement(children, { onClick: handleClose })}</Popover.Target>
      <Popover.Dropdown p={0}>
        <Tabs value={tab} onTabChange={setTab}>
          <Tabs.List grow>
            <Tabs.Tab value="tags">Tags</Tabs.Tab>
            <Tabs.Tab value="meta">Generation Details</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="tags" p="xs">
            <ImageTagTab
              imageTags={imageTags}
              imageNsfw={imageNsfw}
              onChange={({ tags, nsfw }) => {
                setImageTags(tags);
                setImageNsfw(nsfw);
              }}
            />
          </Tabs.Panel>
          <Tabs.Panel value="meta" p="xs">
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
          </Tabs.Panel>
        </Tabs>
        <Group position="right" spacing={4} p="xs">
          <Button fullWidth onClick={handleSubmit}>
            Save
          </Button>
          {tab === 'tags' && (
            <Button
              variant="subtle"
              size="xs"
              onClick={() => {
                onCopyTags?.(imageTags);
                // handleSubmit();
              }}
            >
              Copy tags to all images
            </Button>
          )}
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}

function ImageTagTab({
  imageTags = [],
  imageNsfw,
  onChange,
}: {
  imageTags: SimpleTag[];
  imageNsfw: boolean;
  onChange: (data: { tags: SimpleTag[]; nsfw: boolean }) => void;
}) {
  const [category, ...restTags] = imageTags.reduce((acc, tag) => {
    if (tag.isCategory) acc.unshift(tag.id.toString());
    else acc.push(tag.id.toString());
    return acc;
  }, [] as string[]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(category);
  const [selectedTags, setSelectedTags] = useState<string[]>(restTags);
  const [nsfw, setNsfw] = useState<boolean>(imageNsfw);

  const { data: { items: categories } = { items: [] }, isLoading: loadingCategories } =
    trpc.tag.getAll.useQuery(
      {
        limit: 0,
        entityType: [TagTarget.Image, TagTarget.Model],
        categories: true,
        sort: TagSort.MostImages,
      },
      { cacheTime: Infinity, staleTime: Infinity, keepPreviousData: true }
    );
  const { data: { items: tags } = { items: [] }, isLoading: loadingTags } =
    trpc.tag.getAll.useQuery(
      { limit: 0, entityType: [TagTarget.Image, TagTarget.Model], categories: false },
      { cacheTime: Infinity, staleTime: Infinity, keepPreviousData: true }
    );

  useEffect(() => {
    const allTags = [selectedCategory, ...selectedTags];
    if (!isEqual(imageTags, allTags) || imageNsfw !== nsfw) {
      const tagsData = tags.filter((tag) => selectedTags.includes(tag.id.toString()));
      const category = categories.find((cat) => cat.id.toString() === selectedCategory);
      const tagsToSave = [...(category ? [{ ...category }] : []), ...tagsData];

      onChange({ tags: tagsToSave, nsfw });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, selectedCategory, selectedTags, tags, nsfw]);

  const loading = loadingCategories || loadingTags;

  return (
    <Stack sx={{ position: 'relative' }}>
      <LoadingOverlay visible={loading} />
      <DismissibleAlert
        id="image-tagging"
        title="What is image tagging?"
        content="These tags are used to help showcase your work in the right communities. Good tags will help your image get more love!"
      />
      <Checkbox
        label="This image is for an adult audience (NSFW)"
        checked={nsfw}
        onChange={(e) => setNsfw(e.currentTarget.checked)}
      />
      <Select
        label="Main Category"
        placeholder="Select a category"
        value={selectedCategory}
        onChange={setSelectedCategory}
        data={categories.map((category) => ({
          label: category.name,
          value: category.id.toString(),
        }))}
        limit={50}
        searchable
        clearable
      />
      <MultiSelect
        label="Tags"
        placeholder="Select tags"
        value={selectedTags}
        onChange={setSelectedTags}
        data={tags.map((tag) => ({
          label: tag.name,
          value: tag.id.toString(),
        }))}
        limit={50}
        searchable
        clearable
      />
    </Stack>
  );
}

const useStyles = createStyles((theme, _params) => ({
  sortItem: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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
