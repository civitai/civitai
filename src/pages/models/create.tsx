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
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { z } from 'zod';
import { SortableGrid } from '~/components/SortableGrid/SortableGrid';
import { useS3Upload } from '~/hooks/use-s3-upload';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';
import { modelSchema } from '~/server/common/validation/model';
import { trpc } from '~/utils/trpc';

type CreateModelProps = z.infer<typeof modelSchema>;
type MultiSelectCreatable = Array<{ value: string; label: string }>;
type ImageFile = { id: string; url: string; name: string; file: FileWithPath };

const useStyles = createStyles((_theme, _params, getRef) => ({
  sortItem: {
    cursor: 'pointer',
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
          trainingImages: [],
          exampleImages: [],
        },
      ],
    },
  });
  const { uploadToS3, files, resetFiles } = useS3Upload();

  const [trainedWords, setTrainedWords] = useState<MultiSelectCreatable>([]);
  const [tags, setTags] = useState<MultiSelectCreatable>([]);
  const [trainingImages, setTrainingImages] = useState<ImageFile[]>([]);
  const [exampleImages, setExampleImages] = useState<ImageFile[]>([]);
  const [selectedTrainingImages, setSelectedTrainingImages] = useState<string[]>([]);
  const [selectedExampleImages, setSelectedExampleImages] = useState<string[]>([]);
  const [uploadedModelFiles, uploadedModelFilesHandlers] = useListState<File>([]);

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

  const handleDragEnd = (type: 'training' | 'example') => (event: DragEndEvent) => {
    const { active, over } = event;
    const setItems = type === 'training' ? setTrainingImages : setExampleImages;

    if (active.id !== over?.id) {
      setItems((items) => {
        const ids = items.map(({ id }) => id);
        const oldIndex = ids.indexOf(active.id as string);
        const newIndex = ids.indexOf(over?.id as string);

        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const handleOnDrop = (type: 'training' | 'example') => async (files: FileWithPath[]) => {
    const isTrainingImages = type === 'training';
    const setItems = isTrainingImages ? setTrainingImages : setExampleImages;
    setItems((current) => [
      ...current,
      ...files.map((file) => ({
        id: randomId(),
        url: URL.createObjectURL(file),
        name: file.name,
        file,
      })),
    ]);

    await Promise.all(
      files.map(async (file) => {
        const { url } = await uploadToS3(file, isTrainingImages ? 'training-images' : 'image');

        setItems((items) => {
          const currentItem = items.find((image) => image.file === file);
          if (!currentItem) return items;

          currentItem.url = url;
          return items.filter((item) => item !== currentItem).concat(currentItem);
        });
      })
    );
    resetFiles();
  };

  const handleFileChange = async (file: File | null, index: number) => {
    if (file) {
      uploadedModelFilesHandlers.setItem(index, file);
      const uploaded = await uploadToS3(file, 'model');

      resetFiles();
      form.setFieldValue(`modelVersions.${index}.url`, uploaded.url);
      form.setFieldValue(`modelVersions.${index}.sizeKB`, file.size);
    } else {
      uploadedModelFilesHandlers.remove(index);
      form.setFieldValue(`modelVersions.${index}.url`, null);
      form.setFieldValue(`modelVersions.${index}.sizeKB`, 0);
      resetFiles();
    }
  };

  const renderPreview = (image: ImageFile) => {
    const match = files.find((file) => image.file === file.file);
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
          radius="sm"
          alt={image.name}
          sx={showLoading ? { filter: 'blur(2px)' } : undefined}
          imageProps={{ onLoad: () => URL.revokeObjectURL(image.url) }}
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
            checked={selectedTrainingImages.includes(image.id)}
            onClick={(event) => {
              console.log('clicking', event.target);
            }}
            onChange={(event) => {
              console.log('changed', image, event.target.checked);
              setSelectedTrainingImages((current) =>
                current.includes(image.id)
                  ? current.filter((id) => id !== image.id)
                  : [...current, image.id]
              );
            }}
          />
        </Group>
      </Paper>
    );
  };
  const versionsCount = form.values.modelVersions?.length ?? 0;

  const selectedTrainingImagesCount = selectedTrainingImages.length;
  const allTrainingImagesSelected =
    selectedTrainingImages.length === trainingImages.length && trainingImages.length !== 0;
  const partialTrainingImagesSelected =
    !allTrainingImagesSelected && selectedTrainingImages.length !== 0;

  const selectedExampleImagesCount = selectedExampleImages.length;
  const allExampleImagesSelected =
    selectedExampleImages.length === exampleImages.length && exampleImages.length !== 0;
  const partialExampleImagesSelected =
    !allExampleImagesSelected && selectedExampleImages.length !== 0;

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
                          epochs: 0,
                          steps: 0,
                          sizeKB: 0,
                          url: '',
                        })
                      }
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
                                  placeholder="Pick a file"
                                  onChange={(file) => handleFileChange(file, index)}
                                  value={uploadedModelFiles[index]}
                                  rightSection={
                                    form.values.modelVersions?.[index].url ? (
                                      <IconCircleCheck color="green" size={24} />
                                    ) : null
                                  }
                                  withAsterisk
                                />
                                {files.map(({ file, progress }, i) => {
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
                          </Grid>
                        </Group>
                      </React.Fragment>
                    ))}
                  </Stack>
                </Stack>
              </Paper>
              <Paper radius="md" p="xl" withBorder>
                <Stack>
                  <Group sx={{ justifyContent: 'space-between' }}>
                    {selectedTrainingImagesCount > 0 ? (
                      <>
                        <Group>
                          <Checkbox
                            checked={allTrainingImagesSelected}
                            indeterminate={partialTrainingImagesSelected}
                            onChange={() =>
                              setSelectedTrainingImages(
                                allTrainingImagesSelected
                                  ? []
                                  : trainingImages.map((image) => image.id)
                              )
                            }
                          />
                          <Title order={4}>{`${selectedTrainingImagesCount} ${
                            selectedTrainingImagesCount > 1 ? 'files' : 'file '
                          } selected`}</Title>
                        </Group>
                        <Button
                          color="red"
                          variant="subtle"
                          size="sm"
                          onClick={() => {
                            setTrainingImages([]);
                            setSelectedTrainingImages([]);
                          }}
                        >
                          {selectedTrainingImagesCount > 1 ? 'Delete Files' : 'Delete File'}
                        </Button>
                      </>
                    ) : (
                      <Title order={4}>Training Images</Title>
                    )}
                  </Group>
                  <Dropzone accept={IMAGE_MIME_TYPE} onDrop={handleOnDrop('training')}>
                    <Text align="center">Drop images here</Text>
                  </Dropzone>
                  <SortableGrid
                    items={trainingImages}
                    onDragEnd={handleDragEnd('training')}
                    gridProps={{
                      cols: 3,
                      breakpoints: [{ maxWidth: 'sm', cols: 1 }],
                    }}
                    disabled={partialTrainingImagesSelected}
                  >
                    {renderPreview}
                  </SortableGrid>
                </Stack>
              </Paper>
              <Paper radius="md" p="xl" withBorder>
                <Stack>
                  <Group sx={{ justifyContent: 'space-between' }}>
                    {selectedExampleImagesCount > 0 ? (
                      <>
                        <Group>
                          <Checkbox
                            checked={allExampleImagesSelected}
                            indeterminate={partialExampleImagesSelected}
                            onChange={() =>
                              setSelectedExampleImages(
                                allExampleImagesSelected
                                  ? []
                                  : exampleImages.map((image) => image.id)
                              )
                            }
                          />
                          <Title order={4}>{`${selectedExampleImagesCount} ${
                            selectedExampleImagesCount > 1 ? 'files' : 'file '
                          } selected`}</Title>
                        </Group>
                        <Button
                          color="red"
                          variant="subtle"
                          size="sm"
                          onClick={() => {
                            setExampleImages([]);
                            setSelectedExampleImages([]);
                          }}
                        >
                          {selectedExampleImagesCount > 1 ? 'Delete Files' : 'Delete File'}
                        </Button>
                      </>
                    ) : (
                      <Title order={4}>Example Images</Title>
                    )}
                  </Group>
                  <Dropzone accept={IMAGE_MIME_TYPE} onDrop={handleOnDrop('example')}>
                    <Text align="center">Drop images here</Text>
                  </Dropzone>
                  <SortableGrid
                    items={exampleImages}
                    onDragEnd={handleDragEnd('example')}
                    gridProps={{
                      cols: 3,
                      breakpoints: [{ maxWidth: 'sm', cols: 1 }],
                    }}
                    disabled={partialExampleImagesSelected}
                  >
                    {renderPreview}
                  </SortableGrid>
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

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerAuthSession(ctx);

  if (!session) {
    return {
      redirect: {
        destination: '/login',
        permanent: false,
      },
    };
  }

  return { props: {} };
};
