import {
  Container,
  Group,
  ActionIcon,
  Title,
  Grid,
  Stack,
  Paper,
  TextInput,
  Textarea,
  Button,
  NumberInput,
  Divider,
  Select,
  MultiSelect,
  Checkbox,
} from '@mantine/core';
import { useForm, zodResolver } from '@mantine/form';
import { showNotification } from '@mantine/notifications';
import { Model } from '@prisma/client';
import { IconCheck, IconX, IconArrowLeft, IconPlus, IconTrash } from '@tabler/icons';
import { useRouter } from 'next/router';
import React from 'react';
import { z } from 'zod';
import { FileDrop } from '~/components/FileDrop/FileDrop';
import { FileInputUpload } from '~/components/FileInputUpload/FileInputUpload';
import { UploadTypeUnion } from '~/server/common/enums';
import { modelSchema } from '~/server/common/validation/model';
import { ModelWithDetails } from '~/server/services/models/getById';
import { trpc } from '~/utils/trpc';

type CreateModelProps = z.infer<typeof modelSchema>;

export function ModelForm({ model }: Props) {
  const router = useRouter();
  const initialFormData = model
    ? ({
        ...model,
        tagsOnModels: model?.tagsOnModels.map(({ tag }) => tag.name) ?? [],
        modelVersions:
          model?.modelVersions.map((version) => ({
            ...version,
            images: version.images.map(({ image }) => image),
          })) ?? [],
      } as CreateModelProps)
    : null;
  const form = useForm<CreateModelProps>({
    validate: zodResolver(modelSchema.passthrough()),
    initialValues: initialFormData ?? {
      id: 0,
      name: '',
      description: '',
      trainedWords: [],
      type: 'Checkpoint',
      tagsOnModels: [],
      nsfw: false,
      modelVersions: [
        {
          id: 0,
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

  const addMutation = trpc.model.add.useMutation();
  const updateMutation = trpc.model.update.useMutation();

  const handleSubmit = async (data: CreateModelProps) => {
    await addMutation.mutateAsync(data, {
      onSuccess(results) {
        const response = results as Model;

        showNotification({
          title: 'Your model was uploaded',
          message: 'Successfully created the model',
          color: 'teal',
          icon: <IconCheck size={18} />,
        });
        router.push(`/models/${response.id}`);
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

  const handleOnDrop = (modelIndex: number) => (files: Array<{ name: string; url: string }>) => {
    form.setFieldValue(
      `modelVersions.${modelIndex}.images`,
      files.map((file) => ({ image: { ...file } }))
    );
  };

  const handleFileChange = async ({
    file,
    url,
    type,
    modelIndex,
  }: {
    file: File | null;
    url: string | null;
    type: UploadTypeUnion;
    modelIndex: number;
  }) => {
    const isModelType = type === 'model';

    if (file) {
      if (isModelType) {
        form.setFieldValue(`modelVersions.${modelIndex}.sizeKB`, file.size);
        form.setFieldValue(`modelVersions.${modelIndex}.url`, url);
      } else {
        form.setFieldValue(`modelVersions.${modelIndex}.trainingDataUrl`, url);
      }
    } else {
      if (isModelType) {
        form.setFieldValue(`modelVersions.${modelIndex}.url`, null);
        form.setFieldValue(`modelVersions.${modelIndex}.sizeKB`, 0);
      } else {
        form.setFieldValue(`modelVersions.${modelIndex}.trainingDataUrl`, null);
      }
    }
  };

  const versionsCount = form.values.modelVersions?.length ?? 0;
  const mutating = addMutation.isLoading || updateMutation.isLoading;

  return (
    <Container>
      <Group spacing="lg" mb="lg">
        <ActionIcon variant="outline" size="lg" onClick={() => router.back()}>
          <IconArrowLeft size={20} stroke={1.5} />
        </ActionIcon>
        <Title order={3}>{model ? 'Editing model' : 'Upload model'}</Title>
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
                        <Group p="sm" sx={{ position: 'relative' }}>
                          {versionsCount > 1 && (
                            <ActionIcon
                              color="red"
                              sx={{ position: 'absolute', top: 0, right: 0 }}
                              onClick={() => {
                                form.removeListItem('modelVersions', index);
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
                              <FileInputUpload
                                {...form.getInputProps(`modelVersions.${index}.url`)}
                                label="Model File"
                                placeholder="Pick your model"
                                uploadType="model"
                                fileUrlString={form.values.modelVersions[index].url}
                                onChange={(file, url) =>
                                  handleFileChange({
                                    file,
                                    url,
                                    type: 'model',
                                    modelIndex: index,
                                  })
                                }
                                withAsterisk
                              />
                            </Grid.Col>
                            <Grid.Col span={12}>
                              <FileInputUpload
                                {...form.getInputProps(`modelVersions.${index}.trainingDataUrl`)}
                                label="Training Data"
                                placeholder="Pick your training data"
                                description="The data you used to train your model (in .zip format)"
                                fileUrlString={form.values.modelVersions[index].trainingDataUrl}
                                uploadType="training-images"
                                onChange={(file, url) =>
                                  handleFileChange({
                                    file,
                                    url,
                                    type: 'training-images',
                                    modelIndex: index,
                                  })
                                }
                              />
                            </Grid.Col>
                            <Grid.Col span={12}>
                              <FileDrop
                                title="Example Images"
                                files={form.values.modelVersions[index].images}
                                onDrop={handleOnDrop(index)}
                                onDragEnd={handleOnDrop(index)}
                                onDeleteFiles={(ids: string[]) => {
                                  const currentImages = form.values.modelVersions[index].images;
                                  form.setFieldValue(
                                    `modelVersions.${index}.images`,
                                    currentImages.filter((image) => !ids.includes(image.url))
                                  );
                                }}
                                errors={form.errors[`modelVersions.${index}.images`] as string}
                              />
                            </Grid.Col>
                          </Grid>
                        </Group>
                        {versionsCount > 1 && index !== versionsCount - 1 && <Divider />}
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
                  data={form.values.trainedWords.map((word) => ({ value: word, label: word }))}
                  getCreateLabel={(query) => `+ Create ${query}`}
                  onCreate={(query) => {
                    const item = { value: query, label: query };
                    const currentWords = form.values.trainedWords;
                    form.setFieldValue('trainedWords', [...currentWords, query]);

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
                  data={form.values.tagsOnModels?.map((tag) => ({ value: tag, label: tag }))}
                  getCreateLabel={(query) => `+ Create ${query}`}
                  onCreate={(query) => {
                    const item = { value: query, label: query };
                    const currentTags = form.values.tagsOnModels ?? [];
                    form.setFieldValue('tagsOnModels', [...currentTags, query]);

                    return item;
                  }}
                  clearButtonLabel="Clear tags"
                  creatable
                  clearable
                  searchable
                  {...form.getInputProps('tagsOnModels')}
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
          <Button variant="outline" onClick={() => router.back()} disabled={mutating}>
            Discard changes
          </Button>
          <Button type="submit" loading={mutating}>
            Save
          </Button>
        </Group>
      </form>
    </Container>
  );
}

type Props = { model?: ModelWithDetails };
