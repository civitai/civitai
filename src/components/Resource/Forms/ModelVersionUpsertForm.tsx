import { Card, Divider, Group, Input, Stack, Text, ThemeIcon } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { Currency, ModelType, ModelVersionMonetizationType } from '@prisma/client';
import { IconInfoCircle, IconQuestionMark } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useEffect, useMemo } from 'react';
import { z } from 'zod';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import InputResourceSelectMultiple from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import {
  Form,
  InputMultiSelect,
  InputNumber,
  InputRTE,
  InputSegmentedControl,
  InputSelect,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  constants,
  activeBaseModels,
  modelVersionMonetizationTypeOptions,
  modelVersionSponsorshipSettingsTypeOptions,
} from '~/server/common/constants';
import { ClubResourceSchema } from '~/server/schema/club.schema';
import {
  GenerationResourceSchema,
  generationResourceSchema,
} from '~/server/schema/generation.schema';
import {
  ModelVersionUpsertInput,
  modelVersionUpsertSchema2,
  RecommendedSettingsSchema,
  recommendedSettingsSchema,
} from '~/server/schema/model-version.schema';
import { ModelUpsertInput } from '~/server/schema/model.schema';
import { isEarlyAccess } from '~/server/utils/early-access-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const schema = modelVersionUpsertSchema2
  .extend({
    skipTrainedWords: z.boolean().default(false),
    earlyAccessTimeFrame: z.string().refine((value) => ['0', '1', '3', '7', '14'].includes(value), {
      message: 'Invalid value',
    }),
    useMonetization: z.boolean().default(false),
    recommendedResources: generationResourceSchema
      .merge(recommendedSettingsSchema)
      .array()
      .optional(),
  })
  .refine((data) => (!data.skipTrainedWords ? data.trainedWords.length > 0 : true), {
    message: 'You need to specify at least one trained word',
    path: ['trainedWords'],
  })
  .refine(
    (data) => {
      if (data.settings?.minStrength && data.settings?.maxStrength) {
        return data.settings.minStrength <= data.settings.maxStrength;
      }

      return true;
    },
    { message: 'Min strength must be less than max strength', path: ['settings.minStrength'] }
  )
  .refine(
    (data) => {
      if (data.settings?.minStrength && data.settings.maxStrength) {
        return data.settings.maxStrength >= data.settings.minStrength;
      }

      return true;
    },
    { message: 'Max strength must be greater than min strength', path: ['settings.maxStrength'] }
  );
type Schema = z.infer<typeof schema>;

const baseModelTypeOptions = constants.baseModelTypes.map((x) => ({ label: x, value: x }));
const querySchema = z.object({
  templateId: z.coerce.number().optional(),
  bountyId: z.coerce.number().optional(),
});

export function ModelVersionUpsertForm({ model, version, children, onSubmit }: Props) {
  const features = useFeatureFlags();
  const router = useRouter();
  const queryUtils = trpc.useUtils();

  const acceptsTrainedWords = [
    'Checkpoint',
    'TextualInversion',
    'LORA',
    'LoCon',
    'DoRA',
    'Wildcards',
  ].includes(model?.type ?? '');
  const isTextualInversion = model?.type === 'TextualInversion';
  const hasBaseModelType = ['Checkpoint'].includes(model?.type ?? '');
  const hasVAE = ['Checkpoint'].includes(model?.type ?? '');
  const showStrengthInput = ['LORA', 'Hypernetwork', 'LoCon'].includes(model?.type ?? '');

  // Get VAE options
  const { data: vaes } = trpc.modelVersion.getModelVersionsByModelType.useQuery(
    { type: 'VAE' },
    {
      cacheTime: 60 * 1000,
      enabled: hasVAE,
    }
  );
  const vaeOptions = useMemo(() => {
    if (!vaes) return [];
    return vaes.map((x) => ({ label: x.modelName, value: x.id }));
  }, [vaes]);

  const defaultValues: Schema = {
    ...version,
    name: version?.name ?? 'v1.0',
    baseModel: version?.baseModel ?? 'SD 1.5',
    baseModelType: hasBaseModelType ? version?.baseModelType ?? 'Standard' : undefined,
    vaeId: hasVAE ? version?.vaeId ?? null : null,
    trainedWords: version?.trainedWords ?? [],
    skipTrainedWords: acceptsTrainedWords
      ? version?.trainedWords
        ? !version.trainedWords.length
        : false
      : true,
    earlyAccessTimeFrame:
      version?.earlyAccessTimeFrame && features.earlyAccessModel
        ? String(version.earlyAccessTimeFrame)
        : '0',
    modelId: model?.id ?? -1,
    description: version?.description ?? null,
    epochs: version?.epochs ?? null,
    steps: version?.steps ?? null,
    useMonetization: !!version?.monetization,
    monetization: version?.monetization ?? null,
    requireAuth: version?.requireAuth ?? true,
    recommendedResources: version?.recommendedResources ?? [],
  };

  const form = useForm({ schema, defaultValues, shouldUnregister: false, mode: 'onChange' });

  const skipTrainedWords = !isTextualInversion && (form.watch('skipTrainedWords') ?? false);
  const trainedWords = form.watch('trainedWords') ?? [];
  const monetization = form.watch('monetization') ?? null;
  const sponsorshipSettings = form.watch('monetization.sponsorshipSettings') ?? null;
  const baseModel = form.watch('baseModel') ?? 'SD 1.5';
  const [minStrength, maxStrength] = form.watch([
    'settings.minStrength',
    'settings.maxStrength',
  ]) as number[];
  const { isDirty } = form.formState;
  const canMonetize = !model?.poi;

  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation({
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to save model version',
      });
    },
  });
  const handleSubmit = async ({
    recommendedResources: rawRecommendedResources,
    ...data
  }: Schema) => {
    const schemaResult = querySchema.safeParse(router.query);
    const templateId = schemaResult.success ? schemaResult.data.templateId : undefined;
    const bountyId = schemaResult.success ? schemaResult.data.bountyId : undefined;

    if (isDirty || !version?.id || templateId || bountyId) {
      const recommendedResources =
        rawRecommendedResources?.map(({ id, strength }) => ({
          resourceId: id,
          settings: { strength },
        })) ?? [];

      const result = await upsertVersionMutation.mutateAsync({
        ...data,
        clipSkip: data.clipSkip ?? null,
        epochs: data.epochs ?? null,
        steps: data.steps ?? null,
        modelId: model?.id ?? -1,
        earlyAccessTimeFrame: Number(data.earlyAccessTimeFrame),
        trainedWords: skipTrainedWords ? [] : trainedWords,
        baseModelType: hasBaseModelType ? data.baseModelType : undefined,
        vaeId: hasVAE ? data.vaeId : undefined,
        monetization: data.monetization,
        recommendedResources,
        templateId,
        bountyId,
      });

      await queryUtils.modelVersion.getById.invalidate({ id: result.id, withFiles: true });
      if (model) await queryUtils.model.getById.invalidate({ id: model.id });
      onSubmit(result as ModelVersionUpsertInput);
    } else {
      onSubmit(version as ModelVersionUpsertInput);
    }
  };

  useEffect(() => {
    if (version)
      form.reset({
        ...version,
        modelId: version.modelId ?? model?.id ?? -1,
        baseModel: version.baseModel,
        skipTrainedWords: isTextualInversion
          ? false
          : acceptsTrainedWords
          ? version?.trainedWords
            ? !version.trainedWords.length
            : false
          : true,
        earlyAccessTimeFrame:
          version.earlyAccessTimeFrame && features.earlyAccessModel
            ? String(version.earlyAccessTimeFrame)
            : '0',
        recommendedResources: version.recommendedResources ?? [],
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptsTrainedWords, isTextualInversion, model?.id, version]);

  const atEarlyAccess = isEarlyAccess({
    publishedAt: model?.publishedAt ?? new Date(),
    earlyAccessTimeframe: version?.earlyAccessTimeFrame ?? 0,
    versionCreatedAt: version?.createdAt ?? new Date(),
  });
  const showEarlyAccessInput = version?.status !== 'Published' || atEarlyAccess;
  const canIncreaseEarlyAccess = version?.status !== 'Published';
  const maxEarlyAccessValue = canIncreaseEarlyAccess ? 14 : version?.earlyAccessTimeFrame ?? 0;

  return (
    <>
      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          <InputText
            name="name"
            label="Name"
            placeholder="e.g.: v1.0"
            withAsterisk
            maxLength={25}
          />
          {showEarlyAccessInput && (
            <Input.Wrapper
              label="Early Access"
              description={
                <DismissibleAlert
                  id="ea-info"
                  size="sm"
                  title="Get feedback on your model before full release"
                  content={
                    <>
                      {`This puts your model in the "Early Access" list of models
                  available to `}
                      <Text component={NextLink} href="/pricing" variant="link" target="_blank">
                        Civitai members
                      </Text>
                      {
                        ' of the community. This can be a great way to get feedback from an engaged community before your model is available to the general public. If you choose to enable Early Access, your model will be released to the public after the selected time frame.'
                      }
                    </>
                  }
                  mb="xs"
                />
              }
              error={form.formState.errors.earlyAccessTimeFrame?.message}
            >
              <InputSegmentedControl
                name="earlyAccessTimeFrame"
                data={[
                  { label: 'None', value: '0', disabled: maxEarlyAccessValue < 0 },
                  { label: '1 day', value: '1', disabled: maxEarlyAccessValue < 1 },
                  { label: '3 days', value: '3', disabled: maxEarlyAccessValue < 3 },
                  { label: '1 week', value: '7', disabled: maxEarlyAccessValue < 7 },
                  { label: '2 weeks', value: '14', disabled: maxEarlyAccessValue < 14 },
                ]}
                color="blue"
                size="xs"
                styles={(theme) => ({
                  root: {
                    border: `1px solid ${
                      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
                    }`,
                    background: 'none',
                    marginTop: theme.spacing.xs * 0.5, // 5px
                  },
                })}
                fullWidth
              />
              {!canIncreaseEarlyAccess && (
                <Text size="xs" color="dimmed" mt="sm">
                  You cannot increase early access value after a model has been published
                </Text>
              )}
            </Input.Wrapper>
          )}
          <Group spacing="xs" grow>
            <InputSelect
              name="baseModel"
              label="Base Model"
              placeholder="Base Model"
              withAsterisk
              style={{ flex: 1 }}
              data={activeBaseModels.map((x) => ({ value: x, label: x }))}
            />
            {hasBaseModelType && (
              <InputSelect
                name="baseModelType"
                label="Base Model Type"
                placeholder="Base Model Type"
                data={baseModelTypeOptions}
              />
            )}
          </Group>
          <InputRTE
            key="description"
            name="description"
            label="Version changes or notes"
            description="Tell us about this version"
            includeControls={['formatting', 'list', 'link']}
            editorSize="xl"
          />
          {acceptsTrainedWords && (
            <Stack spacing="xs">
              {!skipTrainedWords && (
                <InputMultiSelect
                  name="trainedWords"
                  label="Trigger Words"
                  placeholder="e.g.: Master Chief"
                  description={`Please input the words you have trained your model with${
                    isTextualInversion ? ' (max 1 word)' : ''
                  }`}
                  data={trainedWords}
                  getCreateLabel={(query) => `+ Create ${query}`}
                  maxSelectedValues={isTextualInversion ? 1 : undefined}
                  creatable
                  clearable
                  searchable
                  required
                />
              )}
              {!isTextualInversion && (
                <InputSwitch
                  name="skipTrainedWords"
                  label="This version doesn't require any trigger words"
                  onChange={(e) =>
                    e.target.checked ? form.setValue('trainedWords', []) : undefined
                  }
                />
              )}
            </Stack>
          )}
          <Stack spacing={4}>
            <Divider label="Training Params" />
            <Group spacing="xs" grow>
              <InputNumber
                name="epochs"
                label="Epochs"
                placeholder="Training Epochs"
                min={0}
                max={100000}
                sx={{ flexGrow: 1 }}
              />
              <InputNumber
                name="steps"
                label="Steps"
                placeholder="Training Steps"
                min={0}
                step={500}
                sx={{ flexGrow: 1 }}
              />
            </Group>
          </Stack>
          <Stack spacing={4}>
            <Divider label="Recommended Settings" />
            <Group spacing="xs" sx={{ '&>*': { flexGrow: 1 } }}>
              <InputNumber
                name="clipSkip"
                label="Clip Skip"
                placeholder="Clip Skip"
                min={1}
                max={12}
              />
              {showStrengthInput && (
                <Group w="100%" align="start" grow>
                  <InputNumber
                    name="settings.minStrength"
                    label="Min Strength"
                    min={-100}
                    max={100}
                    precision={1}
                    step={0.1}
                  />
                  <InputNumber
                    name="settings.maxStrength"
                    label="Max Strength"
                    min={-100}
                    max={100}
                    precision={1}
                    step={0.1}
                  />
                  <InputNumber
                    name="settings.strength"
                    label="Strength"
                    min={minStrength ?? -1}
                    max={maxStrength ?? 2}
                    precision={1}
                    step={0.1}
                  />
                </Group>
              )}
              {hasVAE ? (
                <>
                  {/* <InputResourceSelect
                    name="recommendedResources"
                    type={ModelType.VAE}
                    label={getDisplayName(ModelType.VAE)}
                    buttonLabel="Add VAE"
                    baseModel={baseModel}
                  /> */}
                  <InputSelect
                    name="vaeId"
                    label="VAE"
                    placeholder="VAE"
                    data={vaeOptions}
                    clearable
                    searchable
                  />
                </>
              ) : (
                <InputResourceSelectMultiple
                  name="recommendedResources"
                  label="Resources"
                  description="Select which resources work best with your model"
                  buttonLabel="Add resource"
                  w="100%"
                  limit={10}
                  options={{
                    resources: [{ type: ModelType.Checkpoint, baseModels: [baseModel] }],
                  }}
                />
              )}
            </Group>
          </Stack>
          {canMonetize && (
            <Stack spacing={4}>
              <Divider label="Monetization options" />
              <AlertWithIcon
                icon={<IconInfoCircle size={16} />}
                iconColor="blue"
                radius={0}
                size="xs"
                mb="sm"
              >
                <Text size="xs">
                  {`Monetization is not available yet, however to
                  start gathering interest for the various ways that we're considering, we invite you to select the way you'd prefer to be able to
                  monetize this asset.`}
                </Text>
              </AlertWithIcon>
              <Stack spacing="xs">
                <InputSwitch
                  name="useMonetization"
                  label="I'm interested in monetizing this asset"
                  onChange={(e) => {
                    return e.target.checked
                      ? form.setValue('monetization', {
                          type: ModelVersionMonetizationType.PaidAccess,
                        })
                      : form.setValue('monetization', null);
                  }}
                />
                {monetization && (
                  <>
                    <InputSelect
                      name="monetization.type"
                      label="Monetization Type"
                      placeholder="Please select monetization type"
                      withAsterisk
                      onChange={(type) =>
                        type !== ModelVersionMonetizationType.Sponsored
                          ? form.setValue('monetization.sponsorshipSettings', null)
                          : undefined
                      }
                      style={{ flex: 1 }}
                      data={Object.keys(modelVersionMonetizationTypeOptions).map((k) => {
                        const key = k as keyof typeof modelVersionMonetizationTypeOptions;

                        return {
                          value: k,
                          label: modelVersionMonetizationTypeOptions[key],
                        };
                      })}
                    />

                    {monetization.type && (
                      <Card withBorder py="xs">
                        <Group noWrap>
                          <ThemeIcon color="gray" size={36}>
                            <IconQuestionMark size={20} />
                          </ThemeIcon>
                          <Stack spacing={0}>
                            <Text weight={500} size="xs">
                              {`What is "${
                                modelVersionMonetizationTypeOptions[monetization.type]
                              }"?`}
                            </Text>
                            <Text size="xs">{monetizationTypeExplanation[monetization.type]}</Text>
                          </Stack>
                        </Group>
                      </Card>
                    )}

                    {monetization.type &&
                      (
                        [
                          ModelVersionMonetizationType.PaidAccess,
                          ModelVersionMonetizationType.PaidEarlyAccess,
                          ModelVersionMonetizationType.MySubscribersOnly,
                        ] as ModelVersionMonetizationType[]
                      ).includes(monetization.type) && (
                        <InputNumber
                          name="monetization.unitAmount"
                          label="Desired Price"
                          placeholder="Price"
                          withAsterisk
                          min={0}
                          max={10000}
                          sx={{ flexGrow: 1 }}
                          step={5}
                          icon={<CurrencyIcon currency={Currency.BUZZ} size={18} />}
                        />
                      )}
                  </>
                )}

                {monetization?.type === ModelVersionMonetizationType.Sponsored && (
                  <Group spacing="xs" grow>
                    <InputSelect
                      name="monetization.sponsorshipSettings.type"
                      label="Sponsorship Type"
                      placeholder="Please select sponsorship type"
                      withAsterisk
                      sx={{ flexGrow: 1 }}
                      data={Object.keys(modelVersionSponsorshipSettingsTypeOptions).map((k) => {
                        const key = k as keyof typeof modelVersionSponsorshipSettingsTypeOptions;

                        return {
                          value: k,
                          label: modelVersionSponsorshipSettingsTypeOptions[key],
                        };
                      })}
                    />
                    <InputNumber
                      name="monetization.sponsorshipSettings.unitAmount"
                      label={
                        sponsorshipSettings?.type === 'Bidding' ? 'Minimum Price' : 'Desired Price'
                      }
                      placeholder="Price"
                      withAsterisk
                      min={0}
                      max={10000}
                      sx={{ flexGrow: 1 }}
                      step={5}
                      icon={<CurrencyIcon currency={Currency.BUZZ} size={18} />}
                    />
                  </Group>
                )}
              </Stack>
            </Stack>
          )}
          <Stack spacing={8}>
            <Divider label="Additional options" />

            <InputSwitch
              name="requireAuth"
              label="Require users to be logged in to download this asset"
              description={
                <>
                  This limits a bots ability to download the files associated with this resource.
                  <br />
                  This will also require third-party applications to utilize a user API key to
                  download the asset files.
                </>
              }
            />
          </Stack>
        </Stack>
        {children({ loading: upsertVersionMutation.isLoading })}
      </Form>
    </>
  );
}

type VersionInput = Omit<ModelVersionUpsertInput, 'recommendedResources'> & {
  createdAt: Date | null;
  recommendedResources?: (Omit<
    GenerationResourceSchema,
    'strength' | 'minStrength' | 'maxStrength'
  > &
    RecommendedSettingsSchema)[];
  clubs?: ClubResourceSchema[];
};
type Props = {
  onSubmit: (version?: ModelVersionUpsertInput) => void;
  children: (data: { loading: boolean }) => React.ReactNode;
  model?: Partial<ModelUpsertInput & { publishedAt: Date | null }>;
  version?: Partial<VersionInput>;
};

const monetizationTypeExplanation: Record<ModelVersionMonetizationType, string> = {
  [ModelVersionMonetizationType.PaidAccess]:
    'This option allows you to charge a one-time fee for access to your asset.',
  [ModelVersionMonetizationType.PaidEarlyAccess]:
    'This option allows you to charge a one-time fee for early access (2 weeks) to your asset. After the early access period, your asset will be available to the public.',
  [ModelVersionMonetizationType.CivitaiClubOnly]:
    'This option makes your asset available to Civitai Club members only. Civitai Club is a membership program similar to Spotify, Netflix, or Amazon Prime that allows members to access these assets. Proceeds are then divided among the creators based on the number of times their asset was used.',
  [ModelVersionMonetizationType.MySubscribersOnly]:
    'This option makes your asset available to your subscribers only. This would give you the ability to charge a monthly fee for access to your library of assets similar to Patreon.',
  [ModelVersionMonetizationType.Sponsored]:
    'This option provides a spot for sponsors to advertise their brand or product for a 1-month duration. You can set a fixed price or a bid price with a minimum cost.',
  [ModelVersionMonetizationType.PaidGeneration]:
    'This option allows you to charge a price for each generation performed with your asset.',
};
