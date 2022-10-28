import {
  ActionIcon,
  Button,
  Checkbox,
  Container,
  Divider,
  Grid,
  Group,
  LoadingOverlay,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  Stack,
  Textarea,
  TextInput,
  Text,
  Title,
} from '@mantine/core';
import { useForm, zodResolver } from '@mantine/form';
import { openConfirmModal } from '@mantine/modals';
import { showNotification } from '@mantine/notifications';
import { Model, ModelType } from '@prisma/client';
import { IconCheck, IconX, IconArrowLeft, IconPlus, IconTrash } from '@tabler/icons';
import { TRPCClientErrorBase } from '@trpc/client';
import { DefaultErrorShape } from '@trpc/server';
import { useRouter } from 'next/router';
import React from 'react';
import { z } from 'zod';
import { FileDrop } from '~/components/FileDrop/FileDrop';
import { FileInputUpload } from '~/components/FileInputUpload/FileInputUpload';
import { UploadTypeUnion } from '~/server/common/enums';
import { modelSchema } from '~/server/common/validation/model';
import { ModelWithDetails } from '~/server/validators/models/getById';
import { trpc } from '~/utils/trpc';

type CreateModelProps = z.infer<typeof modelSchema>;
type UpdateModelProps = Omit<CreateModelProps, 'id'> & { id: number };

export function ModelForm({ model }: Props) {
  const router = useRouter();
  const queryUtils = trpc.useContext();
  const editing = !!model;
  const initialFormData = editing
    ? ({
        ...model,
        tagsOnModels: model?.tagsOnModels.map(({ tag }) => tag) ?? [],
        modelVersions:
          model?.modelVersions.map((version) => ({
            ...version,
            images: version.images.map(({ image }) => image),
          })) ?? [],
      } as CreateModelProps)
    : {
        name: '',
        description: '',
        trainedWords: [],
        type: ModelType.Checkpoint,
        tagsOnModels: [],
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
      };
  const form = useForm<CreateModelProps>({
    validate: zodResolver(modelSchema.passthrough()),
    initialValues: initialFormData,
  });

  const { data: tags } = trpc.tag.getAll.useQuery();

  const addMutation = trpc.model.add.useMutation();
  const updateMutation = trpc.model.update.useMutation();
  const deleteVersionMutation = trpc.model.deleteModelVersion.useMutation();

  const handleSubmit = (data: CreateModelProps) => {
    const commonOptions = {
      onSuccess(results: void | Model) {
        const response = results as Model;

        showNotification({
          title: 'Your model was saved',
          message: `Successfully ${editing ? 'updated' : 'created'} the model.`,
          color: 'teal',
          icon: <IconCheck size={18} />,
        });
        queryUtils.model.invalidate();
        router.push(`/models/${response.id}`);
      },
      onError(error: TRPCClientErrorBase<DefaultErrorShape>) {
        const message = error.message;

        showNotification({
          title: 'Could not save model',
          message: `An error occurred while saving the model: ${message}`,
          color: 'red',
          icon: <IconX size={18} />,
        });
      },
    };

    if (editing) updateMutation.mutate(data as UpdateModelProps, commonOptions);
    else addMutation.mutate(data as CreateModelProps, commonOptions);
  };

  const handleOnDrop = (modelIndex: number) => (files: Array<{ name: string; url: string }>) => {
    form.setFieldValue(
      `modelVersions.${modelIndex}.images`,
      files.map((file) => ({ ...file }))
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

  const handleDeleteVersion = (
    version: CreateModelProps['modelVersions'][number],
    index: number
  ) => {
    if (editing && version.id) {
      openConfirmModal({
        title: 'Delete Version',
        children: (
          <Text size="sm">
            Are you sure you want to delete this version? This action is destructive and you will
            have to contact support to restore your data.
          </Text>
        ),
        centered: true,
        labels: { confirm: 'Delete Version', cancel: "No, don't delete it" },
        confirmProps: { color: 'red', loading: deleteVersionMutation.isLoading },
        onConfirm: async () => {
          if (version.id)
            deleteVersionMutation.mutate(
              { id: version.id },
              {
                onSuccess() {
                  queryUtils.model.getById.invalidate({ id: model.id });
                  form.removeListItem('modelVersions', index);
                },
                onError(error) {
                  const message = error.message;

                  showNotification({
                    title: 'Could not delete version',
                    message: `An error occurred while deleting the version: ${message}`,
                    color: 'red',
                    icon: <IconX size={18} />,
                  });
                },
              }
            );
        },
      });
    } else {
      form.removeListItem('modelVersions', index);
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
              <Paper radius="md" p="xl" sx={{ position: 'relative' }} withBorder>
                <LoadingOverlay visible={deleteVersionMutation.isLoading} />
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
                      <React.Fragment key={index}>
                        <Group p="sm" sx={{ position: 'relative' }}>
                          {versionsCount > 1 && (
                            <ActionIcon
                              color="red"
                              sx={{ position: 'absolute', top: 0, right: 0 }}
                              onClick={() => handleDeleteVersion(version, index)}
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
                                files={form.values.modelVersions[index].images as CustomFile[]}
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
                  {...form.getInputProps('type')}
                  label="Type"
                  placeholder="Type"
                  data={['Checkpoint', 'TextualInversion', 'Hypernetwork']}
                  withAsterisk
                />
                <MultiSelect
                  {...form.getInputProps('trainedWords')}
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
                />
                <MultiSelect
                  {...form.getInputProps('tagsOnModels')}
                  label="Tags"
                  placeholder="e.g.: portrait, sharp focus, etc."
                  description="Please add your tags"
                  getCreateLabel={(query) => `+ Create ${query}`}
                  onCreate={(name) => {
                    const item = { value: name, label: name, name };
                    const currentTags = form.values.tagsOnModels ?? [];
                    form.setFieldValue('tagsOnModels', [...currentTags, { name }]);

                    return item;
                  }}
                  data={
                    tags
                      ?.map(({ name }) => ({
                        value: name,
                        label: name,
                        name,
                      }))
                      .concat(
                        form.values.tagsOnModels?.map(({ name }) => ({
                          value: name,
                          label: name,
                          name,
                        })) ?? []
                      ) ?? []
                  }
                  onChange={(values) => {
                    const matches = tags?.filter((tag) => values.includes(tag.name)) ?? [];
                    const unMatched = values
                      .filter((value) => !matches.map((match) => match.name).includes(value))
                      .map((value) => ({ name: value }));
                    form.setFieldValue('tagsOnModels', [...matches, ...unMatched]);
                  }}
                  value={form.values.tagsOnModels?.map(({ name }) => name)}
                  clearButtonLabel="Clear tags"
                  clearable
                  creatable
                  searchable
                />
                <Checkbox
                  {...form.getInputProps('nsfw', { type: 'checkbox' })}
                  label="This model or images associated with it are NSFW"
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
