import {
  ActionIcon,
  Button,
  Container,
  Divider,
  Grid,
  Group,
  Paper,
  Stack,
  Title,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { Model, ModelType } from '@prisma/client';
import { IconArrowLeft, IconCheck, IconPlus, IconTrash, IconX } from '@tabler/icons';
import { TRPCClientErrorBase } from '@trpc/client';
import { DefaultErrorShape } from '@trpc/server';
import { useRouter } from 'next/router';
import React, { useMemo, useState } from 'react';
import { useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import {
  Form,
  InputCheckbox,
  InputFileUpload,
  InputImageUpload,
  InputMultiSelect,
  InputNumber,
  InputRTE,
  InputSelect,
  InputText,
  useForm,
} from '~/libs/form';
import { modelSchema } from '~/server/common/validation/model';
import { ModelWithDetails } from '~/server/validators/models/getById';
import { splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const schema = modelSchema.extend({ tagsOnModels: z.string().array() });

type CreateModelProps = z.infer<typeof modelSchema>;
type UpdateModelProps = Omit<CreateModelProps, 'id'> & { id: number };

type Props = { model?: ModelWithDetails };

export function ModelForm({ model }: Props) {
  const router = useRouter();
  const queryUtils = trpc.useContext();
  const editing = !!model;

  const { data: tags = [] } = trpc.tag.getAll.useQuery({}, { cacheTime: Infinity });
  const addMutation = trpc.model.add.useMutation();
  const updateMutation = trpc.model.update.useMutation();
  const [uploading, setUploading] = useState(false);

  const form = useForm({
    schema: schema,
    shouldUnregister: false,
    mode: 'onChange',
    defaultValues: {
      ...model,
      type: model?.type ?? 'Checkpoint',
      tagsOnModels: model?.tagsOnModels.map(({ tag }) => tag.name) ?? [],
      modelVersions: model?.modelVersions.map((version) => ({
        ...version,
        trainedWords: version.trainedWords ?? [],
        images: version.images.map(({ image }) => image) ?? [],
      })) ?? [
        {
          name: '',
          description: '',
          url: '',
          epochs: null,
          steps: null,
          sizeKB: 0,
          trainingDataUrl: '',
          trainedWords: [],
          images: [],
        },
      ],
    },
  });

  const { fields, append, prepend, remove, swap, move, insert } = useFieldArray({
    control: form.control,
    name: 'modelVersions',
  });

  const tagsOnModels = form.watch('tagsOnModels');

  const tagsData = useMemo(() => {
    return [...tags.map((x) => x.name), ...(tagsOnModels ?? [])?.filter(isDefined)];
  }, [tagsOnModels, tags]);

  const mutating = addMutation.isLoading || updateMutation.isLoading;

  const handleSubmit = (values: z.infer<typeof schema>) => {
    const commonOptions = {
      async onSuccess(results: void | Model) {
        const response = results as Model;

        showNotification({
          title: 'Your model was saved',
          message: `Successfully ${editing ? 'updated' : 'created'} the model.`,
          color: 'teal',
          icon: <IconCheck size={18} />,
        });
        await queryUtils.model.invalidate();
        await queryUtils.tag.invalidate();
        router.push(
          { pathname: `/models/${response.id}`, query: { showNsfw: true } },
          `/models/${response.id}`
        );
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

    const data = {
      ...values,
      tagsOnModels: values.tagsOnModels?.map((name) => {
        const match = tags.find((x) => x.name === name);
        return match ?? { name };
      }),
    };

    if (editing) updateMutation.mutate(data as UpdateModelProps, commonOptions);
    else addMutation.mutate(data as CreateModelProps, commonOptions);
  };

  return (
    <Container>
      <Group spacing="lg" mb="lg">
        <ActionIcon variant="outline" size="lg" onClick={() => router.back()}>
          <IconArrowLeft size={20} stroke={1.5} />
        </ActionIcon>
        <Title order={3}>{model ? 'Editing model' : 'Upload model'}</Title>
      </Group>
      <Form form={form} onSubmit={handleSubmit}>
        <Grid gutter="xl">
          <Grid.Col lg={8}>
            <Stack>
              <Paper radius="md" p="xl" withBorder>
                <Stack>
                  <InputText name="name" label="Name" placeholder="Name" withAsterisk />
                  <InputRTE
                    name="description"
                    label="About your model"
                    description="Tell us what your model does"
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
                        prepend({
                          name: '',
                          description: '',
                          url: '',
                          epochs: null,
                          steps: null,
                          sizeKB: 0,
                          trainingDataUrl: '',
                          images: [],
                          trainedWords: [],
                        })
                      }
                      compact
                    >
                      Add Version
                    </Button>
                  </Group>
                  <Stack>
                    {/* Model Versions */}
                    {fields.map((version, index) => {
                      const modelFile = form.watch(`modelVersions.${index}.url`);
                      const trainingDataUrl = form.watch(`modelVersions.${index}.trainingDataUrl`);
                      const trainedWords = form.watch(`modelVersions.${index}.trainedWords`);
                      return (
                        <Stack key={version.id ?? index} style={{ position: 'relative' }}>
                          {fields.length > 1 && (
                            <ActionIcon
                              color="red"
                              sx={{ position: 'absolute', top: 0, right: 0 }}
                              onClick={() => remove(index)}
                            >
                              <IconTrash size={16} stroke={1.5} />
                            </ActionIcon>
                          )}
                          <Grid gutter="md">
                            <Grid.Col span={12}>
                              <InputText
                                name={`modelVersions.${index}.name`}
                                label="Name"
                                placeholder="Version Name"
                                withAsterisk
                              />
                            </Grid.Col>
                            <Grid.Col span={12}>
                              <InputRTE
                                name={`modelVersions.${index}.description`}
                                label="Version changes or notes"
                                description="Tell us about this version"
                              />
                            </Grid.Col>
                            <Grid.Col span={12}>
                              <InputMultiSelect
                                name={`modelVersions.${index}.trainedWords`}
                                label="Trained Words"
                                placeholder="e.g.: Master Chief"
                                description="Please input the words you have trained your model with"
                                data={trainedWords}
                                creatable
                                getCreateLabel={(query) => `+ Create ${query}`}
                                clearable
                                searchable
                                withAsterisk
                              />
                            </Grid.Col>
                            <Grid.Col span={6}>
                              <InputNumber
                                name={`modelVersions.${index}.epochs`}
                                label="Training Epochs"
                                placeholder="Training Epochs"
                                min={0}
                                max={100}
                              />
                            </Grid.Col>
                            <Grid.Col span={6}>
                              <InputNumber
                                name={`modelVersions.${index}.steps`}
                                label="Training Steps"
                                placeholder="Training Steps"
                                min={0}
                                step={500}
                              />
                            </Grid.Col>
                            <Grid.Col span={12}>
                              <InputFileUpload
                                name={`modelVersions.${index}.url`}
                                label="Model File"
                                placeholder="Pick your model"
                                uploadType="model"
                                accept=".ckpt,.pt"
                                fileUrlString={modelFile}
                                onChange={(url, file) => {
                                  setUploading(!url);
                                  if (file) {
                                    form.setValue(
                                      `modelVersions.${index}.sizeKB`,
                                      file ? file.size / 1024 : 0
                                    );
                                  }
                                }}
                                withAsterisk
                              />
                            </Grid.Col>
                            <Grid.Col span={12}>
                              <InputFileUpload
                                name={`modelVersions.${index}.trainingDataUrl`}
                                label="Training Data"
                                placeholder="Pick your training data"
                                description="The data you used to train your model (as .zip archive)"
                                fileUrlString={trainingDataUrl ?? ''}
                                uploadType="training-images"
                                accept=".zip"
                                onChange={(url) => setUploading(!url)}
                              />
                            </Grid.Col>
                            <Grid.Col span={12}>
                              <InputImageUpload
                                name={`modelVersions.${index}.images`}
                                label="Example Images"
                                hasPrimaryImage
                                withAsterisk
                                onChange={(values) => setUploading(values.some((x) => x.file))}
                              />
                            </Grid.Col>
                          </Grid>
                          {fields.length > 1 && index !== fields.length - 1 && <Divider />}
                        </Stack>
                      );
                    })}
                  </Stack>
                </Stack>
              </Paper>
            </Stack>
          </Grid.Col>
          <Grid.Col lg={4}>
            <Stack sx={{ position: 'sticky', top: 90 }}>
              <Paper radius="md" p="xl" withBorder>
                <Stack>
                  <Title order={4}>Model Properties</Title>
                  <InputSelect
                    name="type"
                    label="Type"
                    placeholder="Type"
                    data={Object.values(ModelType).map((type) => ({
                      label: splitUppercase(type),
                      value: type,
                    }))}
                    withAsterisk
                  />

                  <InputMultiSelect
                    name="tagsOnModels"
                    label="Tags"
                    placeholder="e.g.: portrait, sharp focus, etc."
                    description="Please add your tags"
                    data={tagsData}
                    creatable
                    getCreateLabel={(query) => `+ Create ${query}`}
                    clearable
                    searchable
                  />
                  <InputCheckbox
                    name="nsfw"
                    label="This model or images associated with it are NSFW"
                  />
                </Stack>
              </Paper>
              <Group position="right" mt="lg">
                <Button
                  variant="outline"
                  onClick={() => form.reset()}
                  disabled={!form.formState.isDirty || mutating}
                >
                  Discard changes
                </Button>
                <Button type="submit" loading={mutating} disabled={uploading}>
                  Save
                </Button>
              </Group>
            </Stack>
          </Grid.Col>
        </Grid>
      </Form>
    </Container>
  );
}
