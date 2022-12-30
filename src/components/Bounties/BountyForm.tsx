import {
  ActionIcon,
  Alert,
  Button,
  Container,
  Grid,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { Bounty, ModelType, TagTarget } from '@prisma/client';
import { IconArrowLeft, IconExclamationMark } from '@tabler/icons';
import { TRPCClientErrorBase } from '@trpc/client';
import { DefaultErrorShape } from '@trpc/server';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { z } from 'zod';

import {
  Form,
  InputCheckbox,
  InputDatePicker,
  InputFileUpload,
  InputImageUpload,
  InputMultiSelect,
  InputRTE,
  InputSelect,
  InputText,
  useForm,
} from '~/libs/form';
import { bountyUpsertSchema } from '~/server/schema/bounty.schema';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { BountyById } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { slugit, splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const schema = bountyUpsertSchema.extend({ tags: z.array(z.string()).nullish() });

export function BountyForm({ bounty }: Props) {
  const router = useRouter();
  const queryUtils = trpc.useContext();
  const editing = !!bounty;

  const defaultBounty = {
    ...bounty,
    type: bounty?.type ?? ModelType.Checkpoint,
    tags: bounty?.tags.map((tag) => tag.name) ?? [],
    // HOTFIX: Casting image.meta type issue with generated prisma schema
    images: bounty?.images.map((image) => ({ ...image, meta: image.meta as ImageMetaProps })) ?? [],
  };

  const form = useForm({
    schema,
    shouldUnregister: false,
    mode: 'onChange',
    defaultValues: defaultBounty,
  });
  const [uploading, setUploading] = useState(false);

  const { data: tagsData } = trpc.tag.getAll.useQuery(
    { limit: 0, entityType: TagTarget.Bounty },
    { cacheTime: Infinity, staleTime: Infinity }
  );
  const bountyTags = form.watch('tags');
  const tags = useMemo(
    () =>
      Array.from(new Set([...(bountyTags ?? []), ...(tagsData?.items.map((x) => x.name) ?? [])])),
    [bountyTags, tagsData]
  );

  const addBountyMutation = trpc.bounty.add.useMutation();
  const updateBountyMutation = trpc.bounty.update.useMutation();

  const handleSubmit = (values: z.infer<typeof schema>) => {
    const commonOptions = {
      async onSuccess(results: Bounty | undefined, input: { id?: number }) {
        const bountyLink = `/bounties/${results?.id}/${slugit(results?.name ?? '')}`;

        showSuccessNotification({
          title: 'Your bounty was saved',
          message: `Successfully ${editing ? 'updated' : 'created'} the bounty.`,
        });
        await queryUtils.bounty.invalidate();
        await queryUtils.tag.getAll.invalidate({ limit: 0, entityType: TagTarget.Bounty });
        router.push({ pathname: bountyLink, query: { showNsfw: true } }, bountyLink, {
          shallow: !!input.id,
        });
      },
      onError(error: TRPCClientErrorBase<DefaultErrorShape>) {
        showErrorNotification({
          title: 'Could not save bounty',
          error: new Error(`An error occurred while saving the bounty: ${error.message}`),
        });
      },
    };

    const data: CreateBountyProps | UpdateBountyProps = {
      ...values,
      tags: values.tags?.map((name) => {
        const match = tagsData?.items.find((x) => x.name === name);
        return match ?? { name };
      }),
    };

    if (editing) updateBountyMutation.mutate(data as UpdateBountyProps, commonOptions);
    else addBountyMutation.mutate(data as CreateBountyProps, commonOptions);
  };
  const [poi, nsfw] = form.watch(['poi', 'nsfw']);
  const poiNsfw = poi && nsfw;
  const mutating = addBountyMutation.isLoading || updateBountyMutation.isLoading;

  return (
    <Container size="lg">
      <Group spacing="lg" mb="lg">
        <ActionIcon variant="outline" size="lg" onClick={() => router.back()}>
          <IconArrowLeft size={20} stroke={1.5} />
        </ActionIcon>
        <Title order={3}>{bounty ? 'Editing bounty' : 'Create bounty'}</Title>
      </Group>
      <Form
        form={form}
        onSubmit={handleSubmit}
        onError={() =>
          showErrorNotification({
            error: new Error('Please check the fields marked with red to fix the issues.'),
            title: 'Form Validation Failed',
          })
        }
      >
        <Grid gutter="xl">
          <Grid.Col lg={8}>
            <Paper radius="md" p="xl" withBorder>
              <Stack>
                <InputText name="name" label="Name" placeholder="Name" withAsterisk />
                <InputRTE
                  name="description"
                  label="About the bounty"
                  description="Tell us what this bounty is about"
                  includeControls={['heading', 'formatting', 'list', 'link', 'media']}
                  editorSize="md"
                  withAsterisk
                />
                <InputFileUpload
                  name="file"
                  label="Training data"
                  description="Provide training data for hunters"
                  accept=".zip"
                  placeholder="Select a file"
                  uploadType="Training Data"
                  onLoading={setUploading}
                />
                <InputImageUpload
                  name="images"
                  label="Example Images"
                  max={20}
                  onChange={(values) => setUploading(values.some((x) => x.file))}
                  hasPrimaryImage
                  withAsterisk
                />
              </Stack>
            </Paper>
          </Grid.Col>
          <Grid.Col lg={4}>
            <Stack sx={{ position: 'sticky', top: 90 }}>
              <Paper radius="md" p="xl" withBorder>
                <Stack>
                  <Title order={4}>Bounty Properties</Title>
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
                    name="tags"
                    label="Tags"
                    placeholder="e.g.: portrait, sharp focus, etc."
                    description="Please add your tags"
                    data={tags}
                    creatable
                    getCreateLabel={(query) => `+ Create ${query}`}
                    clearable
                    searchable
                  />
                  <InputDatePicker
                    name="deadline"
                    label="Deadline"
                    description="Set when this bounty expires"
                    placeholder="Select a date"
                  />
                  <Text size="sm" weight={500}>
                    {`This model or it's images:`}
                  </Text>
                  <InputCheckbox
                    name="poi"
                    label="Depict an actual person"
                    description="For Example: Tom Cruise or Tom Cruise as Maverick"
                  />
                  <InputCheckbox name="nsfw" label="Are NSFW" />
                </Stack>
              </Paper>
              {poiNsfw && (
                <>
                  <Alert color="red" pl={10}>
                    <Group noWrap spacing={10}>
                      <ThemeIcon color="red">
                        <IconExclamationMark />
                      </ThemeIcon>
                      <Text size="xs" sx={{ lineHeight: 1.2 }}>
                        NSFW content depicting actual people is not permitted.
                      </Text>
                    </Group>
                  </Alert>
                  <Text size="xs" color="dimmed" sx={{ lineHeight: 1.2 }}>
                    Please revise the content of this listing to ensure no actual person is depicted
                    in an NSFW context out of respect for the individual.
                  </Text>
                </>
              )}

              <Group position="right" mt="lg">
                <Button
                  variant="outline"
                  onClick={() => form.reset()}
                  disabled={!form.formState.isDirty || mutating}
                >
                  Discard changes
                </Button>
                <Button type="submit" loading={mutating || uploading} disabled={poiNsfw}>
                  {uploading ? 'Uploading...' : mutating ? 'Saving...' : 'Save'}
                </Button>
              </Group>
            </Stack>
          </Grid.Col>
        </Grid>
      </Form>
    </Container>
  );
}

type Props = { bounty?: BountyById };

type CreateBountyProps = z.infer<typeof bountyUpsertSchema>;
type UpdateBountyProps = CreateBountyProps & { id: number };
