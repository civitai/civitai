import {
  Alert,
  Anchor,
  Checkbox,
  Group,
  Input,
  Paper,
  Radio,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import {
  CheckpointType,
  CommercialUse,
  ModelType,
  ModelUploadType,
  TagTarget,
} from '~/shared/utils/prisma/enums';
import { IconExclamationMark } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { z } from 'zod';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  Form,
  InputCheckbox,
  InputMultiSelect,
  InputRadioGroup,
  InputRTE,
  InputSegmentedControl,
  InputSelect,
  InputTags,
  InputText,
  InputCollectionSelect,
  useForm,
} from '~/libs/form';
import { TagSort } from '~/server/common/enums';
import { ModelMeta, ModelUpsertInput, modelUpsertSchema } from '~/server/schema/model.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { ModelById } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { parseNumericString } from '~/utils/query-string-helpers';
import { getDisplayName, splitUppercase, titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const schema = modelUpsertSchema
  .extend({
    category: z.number().gt(0, 'Required'),
    description: getSanitizedStringSchema().refine((data) => {
      return data && data.length > 0 && data !== '<p></p>';
    }, 'Cannot be empty'),
    poi: z.string().refine((data) => !!data.length, 'Required'),
    attestation: z.boolean().refine((data) => !!data, 'Required'),
  })
  .refine((data) => (data.type === 'Checkpoint' ? !!data.checkpointType : true), {
    message: 'Please select the checkpoint type',
    path: ['checkpointType'],
  })
  .refine((data) => !(data.nsfw && data.poi === 'true'), {
    message: 'Mature content depicting actual people is not permitted.',
  })
  .refine((data) => !(data.nsfw && data.minor), {
    message:
      'This resource is intended to produce mature themes and cannot be used for NSFW generation',
  });
const querySchema = z.object({
  category: z.preprocess(parseNumericString, z.number().optional()),
  templateId: z.coerce.number().optional(),
  bountyId: z.coerce.number().optional(),
});

const commercialUseOptions: Array<{ value: CommercialUse; label: string }> = [
  { value: CommercialUse.Image, label: 'Sell generated images' },
  { value: CommercialUse.RentCivit, label: 'Use on Civitai generation service' },
  { value: CommercialUse.Rent, label: 'Use on other generation services' },
  { value: CommercialUse.Sell, label: 'Sell this model or merges' },
];

const lockableProperties = ['nsfw', 'poi', 'minor', 'category', 'tags'];

export function ModelUpsertForm({ model, children, onSubmit }: Props) {
  const router = useRouter();
  const result = querySchema.safeParse(router.query);
  const currentUser = useCurrentUser();

  const defaultCategory = result.success ? result.data.category ?? 0 : 0;
  const defaultValues: z.infer<typeof schema> = {
    ...model,
    name: model?.name ?? '',
    description: model?.description ?? '',
    tagsOnModels: model?.tagsOnModels?.filter((tag) => !tag.isCategory) ?? [],
    status: model?.status ?? 'Draft',
    type: model?.type ?? 'Checkpoint',
    checkpointType: model?.checkpointType,
    uploadType: model?.uploadType ?? 'Created',
    poi: model?.poi == null ? '' : model?.poi ? 'true' : 'false',
    nsfw: model?.nsfw ?? false,
    allowCommercialUse: model?.allowCommercialUse ?? [
      CommercialUse.Image,
      CommercialUse.RentCivit,
      CommercialUse.Rent,
      CommercialUse.Sell,
    ],
    allowDerivatives: model?.allowDerivatives ?? true,
    allowNoCredit: model?.allowNoCredit ?? true,
    allowDifferentLicense: model?.allowDifferentLicense ?? true,
    category: model?.tagsOnModels?.find((tag) => !!tag.isCategory)?.id ?? defaultCategory,
    attestation: !!model?.id,
  };

  const form = useForm({ schema, mode: 'onChange', defaultValues, shouldUnregister: false });
  const queryUtils = trpc.useUtils();

  const [type, allowDerivatives] = form.watch(['type', 'allowDerivatives']);
  const [nsfw, poi, minor] = form.watch(['nsfw', 'poi', 'minor']);
  const allowCommercialUse = form.watch('allowCommercialUse');
  const hasPoiInNsfw = nsfw && poi === 'true';
  const hasMinorInNsfw = nsfw && minor;
  const { isDirty, errors } = form.formState;

  const { data, isLoading: loadingCategories } = trpc.tag.getAll.useQuery({
    categories: true,
    entityType: ['Model'],
    unlisted: false,
    sort: TagSort.MostModels,
    limit: 100,
  });
  const categories =
    data?.items.map((tag) => ({ label: titleCase(tag.name), value: tag.id })) ?? [];

  const handleModelTypeChange = (value: ModelType) => {
    form.setValue('checkpointType', null);
    switch (value) {
      case 'Checkpoint':
        form.setValue('checkpointType', CheckpointType.Merge);
        break;
      default:
        break;
    }
  };

  const upsertModelMutation = trpc.model.upsert.useMutation({
    onSuccess: async (data, payload) => {
      await queryUtils.model.getById.invalidate({ id: data.id });
      await queryUtils.model.getAllInfiniteSimple.invalidate();
      if (!payload.id) await queryUtils.model.getMyDraftModels.invalidate();
      onSubmit(data);
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message), title: 'Failed to save model' });
    },
  });
  const handleSubmit = ({
    category,
    tagsOnModels = [],
    poi,
    attestation,
    ...rest
  }: z.infer<typeof schema>) => {
    if (!attestation)
      return form.setError(
        'attestation',
        { message: 'Required', type: 'required' },
        { shouldFocus: true }
      );

    const bountyId = result.success ? result.data.bountyId : undefined;
    if (isDirty || bountyId) {
      const templateId = result.success ? result.data.templateId : undefined;
      const selectedCategory = data?.items.find((cat) => cat.id === category);
      const tags =
        tagsOnModels && selectedCategory ? tagsOnModels.concat([selectedCategory]) : tagsOnModels;
      upsertModelMutation.mutate({
        ...rest,
        tagsOnModels: tags,
        templateId,
        bountyId,
        // manually transform poi
        poi: poi === 'true',
      });
    } else onSubmit(defaultValues);
  };

  useEffect(() => {
    const subscription = form.watch((value, { name }) => {
      if (
        currentUser?.isModerator &&
        name &&
        lockableProperties.includes(name) &&
        !value.lockedProperties?.includes(name)
      ) {
        const locked = (value.lockedProperties ?? []).filter(isDefined);
        form.setValue('lockedProperties', [...locked, name]);
      }
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []); // eslint-disable-line

  useEffect(() => {
    if (model)
      form.reset({
        ...model,
        tagsOnModels: model.tagsOnModels?.filter((tag) => !tag.isCategory) ?? [],
        category: model.tagsOnModels?.find((tag) => tag.isCategory)?.id ?? defaultCategory,
        description: model.description ?? '',
        poi: model?.poi == null ? '' : model?.poi === true ? 'true' : 'false',
        attestation: !!model?.id,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultCategory, model]);

  const modelUser = model?.user?.username ?? currentUser?.username;

  function isLocked(key: string) {
    return !currentUser?.isModerator ? model?.lockedProperties?.includes(key) : false;
  }

  function isLockedDescription(key: string, defaultDescription?: string) {
    return model?.lockedProperties?.includes(key) ? 'Locked by moderator' : defaultDescription;
  }

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <ContainerGrid gutter="xl">
        <ContainerGrid.Col span={12}>
          <Stack>
            <InputText name="name" label="Name" placeholder="Name" withAsterisk />
            <Stack spacing={5}>
              <Group spacing="sm" grow>
                <InputSelect
                  name="type"
                  label="Type"
                  placeholder="Type"
                  data={Object.values(ModelType).map((type) => ({
                    label: getDisplayName(type),
                    value: type,
                  }))}
                  onChange={handleModelTypeChange}
                  disabled={model?.uploadType === ModelUploadType.Trained}
                  withAsterisk
                />
                {type === 'Checkpoint' && (
                  <Input.Wrapper label="Checkpoint Type" withAsterisk>
                    <InputSegmentedControl
                      name="checkpointType"
                      data={Object.values(CheckpointType).map((type) => ({
                        label: splitUppercase(type),
                        value: type,
                      }))}
                      color="blue"
                      styles={(theme) => ({
                        root: {
                          border: `1px solid ${
                            errors.checkpointType
                              ? theme.colors.red[theme.fn.primaryShade()]
                              : theme.colorScheme === 'dark'
                              ? theme.colors.dark[4]
                              : theme.colors.gray[4]
                          }`,
                          background: 'none',
                          height: 36,
                        },
                        label: {
                          padding: '2px 10px',
                        },
                      })}
                      fullWidth
                    />
                  </Input.Wrapper>
                )}
              </Group>
              {errors.checkpointType && <Input.Error>{errors.checkpointType.message}</Input.Error>}
            </Stack>
            <InputSelect
              name="category"
              label="Category"
              disabled={isLocked('category')}
              description={isLockedDescription(
                'category',
                `Selecting the closest match helps users find your resource.`
              )}
              withAsterisk
              placeholder="Select a Category"
              nothingFound="Nothing found"
              data={categories}
              loading={loadingCategories}
              searchable
            />
            <InputTags
              name="tagsOnModels"
              label={
                <Group spacing={4} noWrap>
                  <Input.Label>Tags</Input.Label>
                  <InfoPopover type="hover" size="xs" iconProps={{ size: 14 }}>
                    <Text>
                      Tags are how users filter content on the site. It&apos;s important to
                      correctly tag your content so it can be found by interested users
                    </Text>
                  </InfoPopover>
                </Group>
              }
              description="Search or create tags for your model"
              target={[TagTarget.Model]}
              filter={(tag) =>
                data && tag.name ? !data.items.map((cat) => cat.name).includes(tag.name) : true
              }
            />
            <InputRTE
              name="description"
              label="Description"
              description="Tell us what your model does"
              includeControls={[
                'heading',
                'formatting',
                'list',
                'link',
                'media',
                'mentions',
                'colors',
              ]}
              editorSize="xl"
              placeholder="What does your model do? What's it for? What is your model good at? What should it be used for? What is your resource bad at? How should it not be used?"
              withAsterisk
            />
            {modelUser && (
              <InputCollectionSelect
                name="meta.showcaseCollectionId"
                label="Showcase Collection"
                description="Select the collection this model belongs to"
                username={modelUser}
              />
            )}
          </Stack>
        </ContainerGrid.Col>
        <ContainerGrid.Col span={12}>
          <Stack>
            <Paper radius="md" p="xl" withBorder>
              <ContainerGrid gutter="xs">
                <ContainerGrid.Col xs={12} sm={6}>
                  <Stack spacing="xs">
                    <Text size="md" weight={500} sx={{ lineHeight: 1.2 }} mb="xs">
                      {`When using this model, I give permission for users to:`}
                    </Text>
                    <InputCheckbox name="allowNoCredit" label="Use without crediting me" />
                    <InputCheckbox name="allowDerivatives" label="Share merges of this model" />
                    {allowDerivatives && (
                      <InputCheckbox
                        name="allowDifferentLicense"
                        label="Use different permissions on merges"
                      />
                    )}
                    <Text size="xs" color="dimmed">
                      Learn more about how licensing works by reading our{' '}
                      <Anchor
                        href="https://education.civitai.com/guide-to-licensing-options-on-civitai/ "
                        target="_blank"
                        rel="nofollow noreferrer"
                      >
                        Licensing Guide
                      </Anchor>
                      .
                    </Text>
                  </Stack>
                </ContainerGrid.Col>
                <ContainerGrid.Col xs={12} sm={6}>
                  <Stack spacing="xs">
                    <Stack spacing={4}>
                      <Group spacing={4} noWrap>
                        <Text size="md" weight={500} sx={{ lineHeight: 1.2 }}>
                          Commercial Use
                        </Text>
                        <InfoPopover size="xs" iconProps={{ size: 14 }}>
                          <Text>
                            These permissions determine what others can do with your resource.
                            Select the options that make the most sense for your use case.
                          </Text>
                        </InfoPopover>
                      </Group>
                      <Text size="xs" color="dimmed" sx={{ lineHeight: 1.2 }}>
                        Select all permissions you would like to apply to your model.
                      </Text>
                    </Stack>
                    <Checkbox.Group
                      spacing="xs"
                      value={allowCommercialUse}
                      defaultValue={defaultValues.allowCommercialUse}
                      onChange={(v: CommercialUse[]) => {
                        if (v.includes(CommercialUse.Sell)) {
                          const deduped = new Set([
                            ...v,
                            CommercialUse.RentCivit,
                            CommercialUse.Rent,
                          ]);
                          form.setValue('allowCommercialUse', Array.from(deduped), {
                            shouldDirty: true,
                          });
                        } else if (v.includes(CommercialUse.Rent)) {
                          const deduped = new Set([...v, CommercialUse.RentCivit]);
                          form.setValue('allowCommercialUse', Array.from(deduped), {
                            shouldDirty: true,
                          });
                        } else {
                          form.setValue('allowCommercialUse', v, { shouldDirty: true });
                        }
                      }}
                    >
                      {commercialUseOptions.map(({ value, label }) => (
                        <Checkbox
                          key={value}
                          value={value}
                          label={label}
                          disabled={
                            (value === CommercialUse.RentCivit &&
                              (allowCommercialUse?.includes(CommercialUse.Sell) ||
                                allowCommercialUse?.includes(CommercialUse.Rent))) ||
                            (value === CommercialUse.Rent &&
                              allowCommercialUse?.includes(CommercialUse.Sell))
                          }
                        />
                      ))}
                    </Checkbox.Group>
                  </Stack>
                </ContainerGrid.Col>
              </ContainerGrid>
            </Paper>
            <Paper radius="md" p="xl" withBorder>
              <Stack spacing="xs">
                <Text size="md" weight={500}>
                  This resource:
                </Text>
                <InputRadioGroup
                  name="poi"
                  label="Depicts an actual person (Resource cannot be used on Civitai on-site Generator)"
                  description={isLockedDescription(
                    'category',
                    'This model was trained on real imagery of a living, or deceased, person, or depicts a character portrayed by a real-life actor or actress. E.g. Tom Cruise or Tom Cruise as Maverick.'
                  )}
                  onChange={(value) => {
                    form.setValue('nsfw', value === 'true' ? false : undefined);
                    form.setValue('minor', value === 'true');
                  }}
                >
                  <Radio value="true" label="Yes" disabled={isLocked('poi')} />
                  <Radio value="false" label="No" disabled={isLocked('poi')} />
                </InputRadioGroup>
                <InputCheckbox
                  name="nsfw"
                  label="Is intended to produce mature themes"
                  disabled={isLocked('nsfw') || poi === 'true'}
                  description={isLockedDescription('category')}
                  onChange={(event) =>
                    event.target.checked ? form.setValue('minor', false) : null
                  }
                />
                <InputCheckbox
                  name="minor"
                  label="Cannot be used for NSFW generation"
                  disabled={isLocked('minor') || nsfw}
                  description={isLockedDescription('minor')}
                />
              </Stack>
            </Paper>
            {currentUser?.isModerator && (
              <Paper radius="md" p="xl" withBorder>
                <InputMultiSelect
                  name="lockedProperties"
                  label="Locked properties"
                  data={lockableProperties}
                />
              </Paper>
            )}
            {hasPoiInNsfw && (
              <>
                <Alert color="red" pl={10}>
                  <Group noWrap spacing={10}>
                    <ThemeIcon color="red">
                      <IconExclamationMark />
                    </ThemeIcon>
                    <Text size="xs" sx={{ lineHeight: 1.2 }}>
                      Mature content depicting actual people is not permitted.
                    </Text>
                  </Group>
                </Alert>
                <Text size="xs" color="dimmed" sx={{ lineHeight: 1.2 }}>
                  Please revise the content of this listing to ensure no actual person is depicted
                  in an mature context out of respect for the individual.
                </Text>
              </>
            )}
            {hasMinorInNsfw && (
              <>
                <Alert color="red" pl={10}>
                  <Group noWrap spacing={10}>
                    <ThemeIcon color="red">
                      <IconExclamationMark />
                    </ThemeIcon>
                    <Text size="xs" sx={{ lineHeight: 1.2 }}>
                      This resource is intended to produce mature themes and cannot be used for NSFW
                      generation. These options are mutually exclusive.
                    </Text>
                  </Group>
                </Alert>
                <Text size="xs" color="dimmed" sx={{ lineHeight: 1.2 }}>
                  Please revise the content of this listing.
                </Text>
              </>
            )}
            {!model?.id && (
              <InputCheckbox
                name="attestation"
                label="I acknowledge that I have reviewed the choices above, selected the appropriate option, and understand that my account may be at risk if the selection is found to be incorrect."
              />
            )}
          </Stack>
        </ContainerGrid.Col>
      </ContainerGrid>
      {typeof children === 'function'
        ? children({ loading: upsertModelMutation.isLoading })
        : children}
    </Form>
  );
}

type Props = {
  onSubmit: (data: { id?: number }) => void;
  children: React.ReactNode | ((data: { loading: boolean }) => React.ReactNode);
  model?: Partial<Omit<ModelById, 'tagsOnModels'> & ModelUpsertInput>;
};
