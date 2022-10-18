import { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import {
  ActionIcon,
  Button,
  Checkbox,
  Container,
  Divider,
  FileButton,
  FileInput as MantineFileInput,
  Grid,
  Group,
  Image,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { Dropzone, FileWithPath, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useForm, zodResolver } from '@mantine/form';
import { randomId } from '@mantine/hooks';
import { IconArrowLeft, IconPlus, IconTrash, IconUpload } from '@tabler/icons';
import { GetServerSideProps } from 'next';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { z } from 'zod';
import { SortableGrid } from '~/components/SortableGrid/SortableGrid';
import { useS3Upload } from '~/hooks/use-s3-upload';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';
import { modelSchema } from '~/server/common/validation/model';

type CreateModelProps = Partial<z.infer<typeof modelSchema>>;
type MultiSelectCreatable = Array<{ value: string; label: string }>;
type ImageFile = { id: string; url: string; name: string };

export default function Create() {
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
          url: undefined,
          epochs: 0,
          steps: 0,
          trainingImages: [],
          exampleImages: [],
        },
      ],
    },
  });
  const { FileInput, uploadToS3 } = useS3Upload();

  const [trainedWords, setTrainedWords] = useState<MultiSelectCreatable>([]);
  const [tags, setTags] = useState<MultiSelectCreatable>([]);
  const [trainingImages, setTrainingImages] = useState<ImageFile[]>([]);
  const [exampleImages, setExampleImages] = useState<ImageFile[]>([]);

  const handleSubmit = (data: CreateModelProps) => {
    console.log({ data });
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

  const handleOnDrop = (type: 'training' | 'example') => (files: FileWithPath[]) => {
    const images = files.map((file) => ({
      id: randomId(),
      url: URL.createObjectURL(file),
      name: file.name,
    }));
    const setItems = type === 'training' ? setTrainingImages : setExampleImages;

    setItems((current) => [...current, ...images]);
  };

  const handleFileChange = async (files: File[], index: number) => {
    const [uploaded] = await Promise.all(files.map((file) => uploadToS3(file, 'model')));

    form.setFieldValue(`modelVersions.${index}.url`, uploaded.url);
  };

  const renderPreview = (image: ImageFile) => {
    return (
      <Paper radius="sm" withBorder>
        <Image
          key={image.id}
          src={image.url}
          alt={image.name}
          imageProps={{ onLoad: () => URL.revokeObjectURL(image.url) }}
          fit="contain"
        />
      </Paper>
    );
  };
  const versionsCount = form.values.modelVersions?.length ?? 0;

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
                              onClick={() => form.removeListItem('modelVersions', index)}
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
                              <FileInput
                                onChange={(file: File[]) => handleFileChange(file, index)}
                                {...form.getInputProps(`modelVersions.${index}.url`)}
                              />
                              <FileButton
                                onChange={(file) =>
                                  file ? handleFileChange([file], index) : undefined
                                }
                                multiple={false}
                                accept="image/png,image/jpeg"
                              >
                                {(props) => (
                                  <Button leftIcon={<IconUpload size={16} />} {...props}>
                                    Pick a file
                                  </Button>
                                )}
                              </FileButton>
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
                  <Title order={4}>Training Images</Title>
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
                  >
                    {renderPreview}
                  </SortableGrid>
                </Stack>
              </Paper>
              <Paper radius="md" p="xl" withBorder>
                <Stack>
                  <Title order={4}>Example Images</Title>
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
          <Button type="submit">Submit</Button>
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
