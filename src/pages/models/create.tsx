import { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import {
  ActionIcon,
  Button,
  Checkbox,
  Container,
  createStyles,
  Divider,
  FileInput,
  Grid,
  Group,
  Image,
  MultiSelect,
  NumberInput,
  Paper,
  Progress,
  RingProgress,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { Dropzone, FileWithPath, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useForm, zodResolver } from '@mantine/form';
import { randomId, useListState } from '@mantine/hooks';
import { showNotification } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconCheck,
  IconCircleCheck,
  IconGripVertical,
  IconPlus,
  IconTrash,
  IconUpload,
  IconX,
  IconZoomIn,
} from '@tabler/icons';
import { GetServerSideProps } from 'next';
import { Session } from 'next-auth';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { SortableGrid } from '~/components/SortableGrid/SortableGrid';
import { useS3Upload } from '~/hooks/use-s3-upload';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';
import { modelSchema } from '~/server/common/validation/model';
import { trpc } from '~/utils/trpc';

type CreateModelProps = z.infer<typeof modelSchema>;
type MultiSelectCreatable = Array<{ value: string; label: string }>;
type ImageFile = {
  id: string;
  url: string;
  name: string;
  file: FileWithPath;
  preview?: string;
};

const useStyles = createStyles((_theme, _params, getRef) => ({
  sortItem: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',

    [`&:hover .${getRef('actionsGroup')}`]: {
      opacity: 1,
      transition: 'all 0.2s ease',
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
    background: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    top: 0,
    left: 0,
  },
}));

export default function Create() {
  const { data: session } = useSession();
  const { classes, cx } = useStyles();
  const router = useRouter();
  const form = useForm<CreateModelProps>({
    validate: zodResolver(modelSchema.passthrough()),
    initialValues: {
      name: '',
      description: '',
      trainedWords: [],
      type: 'Checkpoint',
      tags: [],
      nsfw: false,
      modelVersions: [
        {
          name: '',
          description: '',
          url: '',
          epochs: 0,
          steps: 0,
          sizeKB: 0,
          trainingDataUrl: '',
          images: [],
        },
      ],
    },
  });
  const {
    uploadToS3: uploadImageFiles,
    files: imageFiles,
    resetFiles: resetImageFiles,
  } = useS3Upload();
  const { uploadToS3: uploadModelFile, files: modelFiles } = useS3Upload();
  const { uploadToS3: uploadTrainingDataFile, files: trainingDataFiles } = useS3Upload();

  const [trainedWords, setTrainedWords] = useState<MultiSelectCreatable>([]);
  const [tags, setTags] = useState<MultiSelectCreatable>([]);
  const [exampleImages, exampleImagesHandlers] = useListState<ImageFile[]>([]);
  const [selectedImages, selectedImagesHandlers] = useListState<string[]>([]);
  const [uploadedModelFiles, uploadedModelFilesHandlers] = useListState<File>([]);
  const [uploadedTrainingFiles, uploadedTrainingFilesHandlers] = useListState<File>([]);

  const { mutateAsync, isLoading } = trpc.model.add.useMutation();

  const handleSubmit = async (data: CreateModelProps) => {
    await mutateAsync(data, {
      onSuccess(results) {
        showNotification({
          title: 'Your model was uploaded',
          message: 'Successfully created the model',
          color: 'teal',
          icon: <IconCheck size={18} />,
        });
        router.push(`/models/${results.id}`);
      },
      onError(error) {
        const message = error.message;

        showNotification({
          title: 'Could not upload model',
          message: `An error occurred while uploading the model: ${message}`,
          color: 'red',
          icon: <IconX size={18} />,
        });
      },
    });
  };

  const handleDragEnd = (modelIndex: number) => (event: DragEndEvent) => {
    const { active, over } = event;

    if (active.id !== over?.id) {
      const items = [...(exampleImages[modelIndex] ?? [])];
      const ids = items.map(({ id }) => id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over?.id as string);

      exampleImagesHandlers.setItem(modelIndex, arrayMove(items, oldIndex, newIndex));
    }
  };

  const handleOnDrop = (modelIndex: number) => async (files: FileWithPath[]) => {
    exampleImagesHandlers.setItem(modelIndex, [
      ...(exampleImages[modelIndex] ?? []),
      ...files.map((file) => ({
        id: randomId(),
        url: URL.createObjectURL(file),
        name: file.name,
        file,
      })),
    ]);

    const uploadedImages = await Promise.all(
      files.map(async (file) => {
        const { url } = await uploadImageFiles(file, 'image');

        const items = [...(exampleImages[modelIndex] ?? [])];
        const currentItem = items.find((image) => image.file === file);
        if (!currentItem) return items;

        // clear previously created preview to prevent memory leaks
        URL.revokeObjectURL(currentItem.url);
        currentItem.url = url;

        exampleImagesHandlers.setItem(
          modelIndex,
          items.filter((item) => item !== currentItem).concat(currentItem)
        );

        return { url, name: file.name, userId: session?.user?.id };
      })
    );

    form.setFieldValue(`modelVersions.${modelIndex}.images`, uploadedImages);
    resetImageFiles();
  };

  const handleFileChange = async ({
    file,
    type,
    index,
  }: {
    file: File | null;
    type: 'training-images' | 'model';
    index: number;
  }) => {
    const isModelType = type === 'model';
    const uploadedFilesHandlers = isModelType
      ? uploadedModelFilesHandlers
      : uploadedTrainingFilesHandlers;

    if (file) {
      uploadedFilesHandlers.setItem(index, file);

      const uploadFile = isModelType ? uploadModelFile : uploadTrainingDataFile;
      const uploaded = await uploadFile(file, type);

      if (isModelType) {
        form.setFieldValue(`modelVersions.${index}.sizeKB`, file.size);
        form.setFieldValue(`modelVersions.${index}.url`, uploaded.url);
      } else {
        form.setFieldValue(`modelVersions.${index}.trainingDataUrl`, uploaded.url);
      }
    } else {
      uploadedFilesHandlers.remove(index);

      if (isModelType) {
        form.setFieldValue(`modelVersions.${index}.url`, null);
        form.setFieldValue(`modelVersions.${index}.sizeKB`, 0);
      } else {
        form.setFieldValue(`modelVersions.${index}.trainingDataUrl`, null);
      }
    }
  };

  const renderPreview = (image: ImageFile, modelIndex: number) => {
    const match = imageFiles.find((file) => image.file === file.file);
    const { progress } = match ?? { progress: 0 };
    const showLoading = match && progress < 100;

    return (
      <Paper
        className={cx({ [classes.sortItem]: !showLoading })}
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
          <IconZoomIn size={32} stroke={1.5} color="white" />
          <IconGripVertical
            size={24}
            stroke={1.5}
            className={classes.draggableIcon}
            color="white"
          />
          <Checkbox
            className={classes.checkbox}
            size="xs"
            checked={selectedImages[modelIndex]?.includes(image.id)}
            onChange={() => {
              const items = selectedImages[modelIndex] ?? [];
              selectedImagesHandlers.setItem(
                modelIndex,
                items.includes(image.id)
                  ? items.filter((id) => id !== image.id)
                  : [...items, image.id]
              );
            }}
          />
        </Group>
      </Paper>
    );
  };

  useEffect(() => {
    // clear any remaining urls when unmounting
    return () =>
      exampleImages.forEach((images) => images.forEach((image) => URL.revokeObjectURL(image.url)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exampleImages]);

  const versionsCount = form.values.modelVersions?.length ?? 0;

  const selectedImagesCount = (modelIndex: number) => selectedImages[modelIndex]?.length;
  const allImagesSelected = (modelIndex: number) =>
    selectedImages[modelIndex]?.length === exampleImages[modelIndex]?.length &&
    exampleImages[modelIndex]?.length !== 0;
  const partialImagesSelected = (modelIndex: number) =>
    !allImagesSelected(modelIndex) && selectedImages[modelIndex]?.length !== 0;

  return (
    <Container>
      <Group spacing="lg" mb="lg">
        <ActionIcon variant="outline" size="lg" onClick={() => router.back()}>
          <IconArrowLeft size={20} stroke={1.5} />
        </ActionIcon>
        <Title order={3}>Upload model</Title>
      </Group>
      <form onSubmit={form.onSubmit(handleSubmit, console.error)} noValidate>
        <Grid gutter="xl">
          <Grid.Col lg={8}>
            <Stack spacing="xl">
              <Paper radius="md" p="xl" withBorder>
                <Stack>
                  <TextInput
                    label="Name"
                    placeholder="Name"
                    withAsterisk
                    {...form.getInputProps('name')}
                  />
                  <Textarea
                    label="About your model"
                    placeholder="Tell us what your model does"
                    maxLength={240}
                    {...form.getInputProps('description')}
                  />
                </Stack>
              </Paper>
              <Paper radius="md" p="xl" withBorder>
                <Stack>
                  <Group sx={{ justifyContent: 'space-between' }}>
                    <Title order={4}>Model Versions</Title>
                    <Button
                      size="xs"
                      leftIcon={<IconPlus size={16} />}
                      variant="outline"
                      onClick={() =>
                        form.insertListItem('modelVersions', {
                          name: '',
                          description: '',
                          url: '',
                          epochs: 0,
                          steps: 0,
                          sizeKB: 0,
                          trainingDataUrl: '',
                          images: [],
                        })
                      }
                      compact
                    >
                      Add Version
                    </Button>
                  </Group>
                  <Stack sx={{ flexDirection: 'column-reverse' }}>
                    {form.values.modelVersions?.map((version, index) => (
                      <React.Fragment key={version.id ?? index}>
                        {versionsCount > 1 && <Divider />}
                        <Group p="sm" sx={{ position: 'relative' }}>
                          {versionsCount > 1 && (
                            <ActionIcon
                              color="red"
                              sx={{ position: 'absolute', top: 0, right: 0 }}
                              onClick={() => {
                                form.removeListItem('modelVersions', index);
                                uploadedModelFilesHandlers.remove(index);
                              }}
                            >
                              <IconTrash size={16} stroke={1.5} />
                            </ActionIcon>
                          )}
                          <Grid gutter="md">
                            <Grid.Col span={12}>
                              <TextInput
                                label="Name"
                                placeholder="Version Name"
                                width="100%"
                                withAsterisk
                                {...form.getInputProps(`modelVersions.${index}.name`)}
                              />
                            </Grid.Col>
                            <Grid.Col span={12}>
                              <Textarea
                                label="Version changes or notes"
                                placeholder="Tell us about this version"
                                maxLength={240}
                                {...form.getInputProps(`modelVersions.${index}.description`)}
                              />
                            </Grid.Col>
                            <Grid.Col span={6}>
                              <NumberInput
                                label="Training Epochs"
                                placeholder="Training Epochs"
                                min={0}
                                max={100}
                                {...form.getInputProps(`modelVersions.${index}.epochs`)}
                              />
                            </Grid.Col>
                            <Grid.Col span={6}>
                              <NumberInput
                                label="Training Steps"
                                placeholder="Training Steps"
                                min={0}
                                step={500}
                                {...form.getInputProps(`modelVersions.${index}.steps`)}
                              />
                            </Grid.Col>
                            <Grid.Col span={12}>
                              <Stack>
                                <FileInput
                                  {...form.getInputProps(`modelVersions.${index}.url`)}
                                  label="Model File"
                                  icon={<IconUpload size={16} />}
                                  placeholder="Pick your model"
                                  onChange={(file) =>
                                    handleFileChange({ file, index, type: 'model' })
                                  }
                                  value={uploadedModelFiles[index]}
                                  rightSection={
                                    form.values.modelVersions?.[index].url ? (
                                      <IconCircleCheck color="green" size={24} />
                                    ) : null
                                  }
                                  withAsterisk
                                />
                                {modelFiles.map(({ file, progress }, i) => {
                                  return file === uploadedModelFiles[index] ? (
                                    <Progress
                                      key={i}
                                      size="xl"
                                      value={progress}
                                      label={`${Math.floor(progress)}%`}
                                      color={progress < 100 ? 'blue' : 'green'}
                                    />
                                  ) : null;
                                })}
                              </Stack>
                            </Grid.Col>
                            <Grid.Col span={12}>
                              <Stack>
                                <FileInput
                                  {...form.getInputProps(`modelVersions.${index}.trainingDataUrl`)}
                                  label="Training Data"
                                  icon={<IconUpload size={16} />}
                                  placeholder="Pick your training data"
                                  description="The data you used to train your model (in .zip format)"
                                  accept="application/zip"
                                  onChange={(file) =>
                                    handleFileChange({ file, index, type: 'training-images' })
                                  }
                                  value={uploadedTrainingFiles[index]}
                                  rightSection={
                                    form.values.modelVersions?.[index].trainingDataUrl ? (
                                      <IconCircleCheck color="green" size={24} />
                                    ) : null
                                  }
                                />
                                {trainingDataFiles.map(({ file, progress }, i) => {
                                  return file === uploadedTrainingFiles[index] ? (
                                    <Progress
                                      key={i}
                                      size="xl"
                                      value={progress}
                                      label={`${Math.floor(progress)}%`}
                                      color={progress < 100 ? 'blue' : 'green'}
                                    />
                                  ) : null;
                                })}
                              </Stack>
                            </Grid.Col>
                            <Grid.Col span={12}>
                              <Stack>
                                <Group sx={{ justifyContent: 'space-between' }}>
                                  {selectedImagesCount(index) > 0 ? (
                                    <>
                                      <Group>
                                        <Checkbox
                                          checked={allImagesSelected(index)}
                                          indeterminate={partialImagesSelected(index)}
                                          onChange={() =>
                                            selectedImagesHandlers.setItem(
                                              index,
                                              allImagesSelected(index)
                                                ? []
                                                : exampleImages[index].map((image) => image.id)
                                            )
                                          }
                                        />
                                        <Title order={5}>{`${selectedImagesCount(index)} ${
                                          selectedImagesCount(index) > 1 ? 'files' : 'file '
                                        } selected`}</Title>
                                      </Group>
                                      <Button
                                        color="red"
                                        variant="subtle"
                                        size="sm"
                                        onClick={() => {
                                          const items = [...exampleImages[index]];
                                          exampleImagesHandlers.setItem(
                                            index,
                                            items.filter(
                                              (item) => !selectedImages[index]?.includes(item.id)
                                            )
                                          );
                                          selectedImagesHandlers.setItem(index, []);
                                          form.setFieldValue(
                                            `modelVersions.${index}.exampleImages`,
                                            []
                                          );
                                        }}
                                      >
                                        {selectedImagesCount(index) > 1
                                          ? 'Delete Files'
                                          : 'Delete File'}
                                      </Button>
                                    </>
                                  ) : (
                                    <Title order={5}>Example Images</Title>
                                  )}
                                </Group>
                                <Dropzone
                                  accept={IMAGE_MIME_TYPE}
                                  onDrop={handleOnDrop(index)}
                                  maxFiles={10}
                                  styles={(theme) => ({
                                    root: {
                                      borderColor: form.errors[`modelVersions.${index}.images`]
                                        ? theme.colors.red[6]
                                        : undefined,
                                    },
                                  })}
                                >
                                  <Text align="center">Drop images here</Text>
                                </Dropzone>
                                {form.errors[`modelVersions.${index}.images`] ? (
                                  <Text color="red" size="xs">
                                    {form.errors[`modelVersions.${index}.images`]}
                                  </Text>
                                ) : null}
                                <SortableGrid
                                  items={exampleImages[index] ?? []}
                                  onDragEnd={handleDragEnd(index)}
                                  gridProps={{
                                    cols: 3,
                                    breakpoints: [{ maxWidth: 'sm', cols: 1 }],
                                  }}
                                  disabled={partialImagesSelected(index)}
                                >
                                  {renderPreview}
                                </SortableGrid>
                              </Stack>
                            </Grid.Col>
                          </Grid>
                        </Group>
                      </React.Fragment>
                    ))}
                  </Stack>
                </Stack>
              </Paper>
            </Stack>
          </Grid.Col>
          <Grid.Col lg={4}>
            <Paper radius="md" p="xl" withBorder>
              <Stack>
                <Title order={4}>Model Properties</Title>
                <Select
                  label="Type"
                  placeholder="Type"
                  data={['Checkpoint', 'TextualInversion', 'Hypernetwork']}
                  withAsterisk
                  {...form.getInputProps('type')}
                />
                <MultiSelect
                  label="Trained Words"
                  placeholder="e.g.: Master Chief"
                  description="Please input the words you have trained your model with"
                  data={trainedWords}
                  getCreateLabel={(query) => `+ Create ${query}`}
                  onCreate={(query) => {
                    const item = { value: query, label: query };
                    setTrainedWords((current) => [...current, item]);

                    return item;
                  }}
                  clearButtonLabel="Clear trained words"
                  creatable
                  clearable
                  searchable
                  withAsterisk
                  {...form.getInputProps('trainedWords')}
                />
                <MultiSelect
                  label="Tags"
                  placeholder="e.g.: portrait, sharp focus, etc."
                  description="Please add your tags"
                  data={tags}
                  getCreateLabel={(query) => `+ Create ${query}`}
                  onCreate={(query) => {
                    const item = { value: query, label: query };
                    setTags((current) => [...current, item]);

                    return item;
                  }}
                  clearButtonLabel="Clear tags"
                  creatable
                  clearable
                  searchable
                  {...form.getInputProps('tags')}
                />
                <Checkbox
                  label="This model or images associated with it are NSFW"
                  {...form.getInputProps('nsfw', { type: 'checkbox' })}
                />
              </Stack>
            </Paper>
          </Grid.Col>
        </Grid>

        <Group position="right" mt="lg">
          <Button variant="outline" onClick={() => router.back()}>
            Discard changes
          </Button>
          <Button type="submit" loading={isLoading}>
            Save
          </Button>
        </Group>
      </form>
    </Container>
  );
}

type Props = { session: Session };

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const session = await getServerAuthSession(ctx);

  if (!session) {
    return {
      redirect: {
        destination: '/login',
        permanent: false,
      },
    };
  }

  return { props: { session } };
};
