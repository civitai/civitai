import {
  Alert,
  Anchor,
  Card,
  Divider,
  Group,
  Input,
  Popover,
  SegmentedControl,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { getQueryKey } from '@trpc/react-query';
import { isEqual, uniq } from 'lodash-es';
import { useRouter } from 'next/router';
import React, { useEffect, useMemo } from 'react';
import { z } from 'zod';

import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import InputResourceSelectMultiple from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import {
  MAX_DONATION_GOAL,
  MIN_DONATION_GOAL,
} from '~/components/Model/ModelVersions/model-version.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  Form,
  InputMultiSelect,
  InputNumber,
  InputRTE,
  InputSelect,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { activeBaseModels, constants } from '~/server/common/constants';
import { ClubResourceSchema } from '~/server/schema/club.schema';
import {
  GenerationResourceSchema,
  generationResourceSchema,
} from '~/server/schema/generation.schema';
import {
  earlyAccessConfigInput,
  ModelVersionEarlyAccessConfig,
  ModelVersionUpsertInput,
  modelVersionUpsertSchema2,
  RecommendedSettingsSchema,
  recommendedSettingsSchema,
} from '~/server/schema/model-version.schema';
import { ModelUpsertInput } from '~/server/schema/model.schema';
import {
  getMaxEarlyAccessDays,
  getMaxEarlyAccessModels,
} from '~/server/utils/early-access-helpers';
import { ModelType, ModelUsageControl } from '~/shared/utils/prisma/enums';
import { MyRecentlyRecommended } from '~/types/router';
import { isFutureDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';
import { queryClient, trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const schema = modelVersionUpsertSchema2
  .extend({
    skipTrainedWords: z.boolean().default(false),
    earlyAccessConfig: earlyAccessConfigInput
      .omit({
        originalPublishedAt: true,
      })
      .extend({
        timeframe: z
          .number()
          .refine((v) => constants.earlyAccess.timeframeValues.some((x) => x === v), {
            message: 'Invalid value',
          }),
      })
      .nullish(),
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
  )
  .refine(
    (data) => {
      const { generationPrice, downloadPrice } = data.earlyAccessConfig ?? {};
      if (generationPrice && downloadPrice) {
        return generationPrice <= downloadPrice;
      }

      return true;
    },
    { message: 'Generation price cannot be greater than download price', path: ['generationPrice'] }
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
  const currentUser = useCurrentUser();

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
  const showStrengthInput = ['LORA', 'Hypernetwork', 'LoCon', 'DoRA'].includes(model?.type ?? '');
  const isEarlyAccessOver =
    version?.status === 'Published' &&
    (!version?.earlyAccessEndsAt || !isFutureDate(version?.earlyAccessEndsAt));

  const MAX_EARLY_ACCCESS = 15;

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
    earlyAccessConfig:
      version?.earlyAccessConfig &&
      !!version?.earlyAccessConfig?.timeframe &&
      features.earlyAccessModel
        ? {
            ...(version?.earlyAccessConfig ?? {}),
            timeframe:
              version.earlyAccessConfig?.timeframe ?? constants.earlyAccess.timeframeValues[0],
          }
        : null,
    modelId: model?.id ?? -1,
    description: version?.description ?? null,
    epochs: version?.epochs ?? null,
    steps: version?.steps ?? null,
    useMonetization: !!version?.monetization,
    monetization: version?.monetization ?? null,
    requireAuth: version?.requireAuth ?? true,
    recommendedResources: version?.recommendedResources ?? [],
    // Being extra safe here and ensuring this value exists.
    usageControl: !!version?.usageControl
      ? version?.usageControl ?? ModelUsageControl.Download
      : ModelUsageControl.Download,
  };

  const form = useForm({ schema, defaultValues, shouldUnregister: false, mode: 'onChange' });

  const skipTrainedWords = !isTextualInversion && (form.watch('skipTrainedWords') ?? false);
  const trainedWords = form.watch('trainedWords') ?? [];
  const baseModel = form.watch('baseModel') ?? 'SD 1.5';
  const recResources = form.watch('recommendedResources') ?? [];
  const [minStrength, maxStrength] = form.watch([
    'settings.minStrength',
    'settings.maxStrength',
  ]) as number[];
  const { isDirty } = form.formState;
  const earlyAccessConfig = form.watch('earlyAccessConfig');
  const usageControl = form.watch('usageControl');
  const canSave = true;

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

    if (
      isDirty ||
      !version?.id ||
      templateId ||
      bountyId ||
      !isEqual(data.earlyAccessConfig, version.earlyAccessConfig)
    ) {
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
        earlyAccessConfig: !data.earlyAccessConfig ? null : data.earlyAccessConfig,
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
      if (rawRecommendedResources?.length) {
        const queryKey = getQueryKey(trpc.model.getRecentlyRecommended);
        queryClient.setQueriesData<MyRecentlyRecommended>({ queryKey, exact: false }, (old) => {
          if (!old) return;
          return uniq([
            ...rawRecommendedResources.map((r) => r.model.id).filter(isDefined),
            ...old,
          ]);
        });
      }
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
        earlyAccessConfig:
          version?.earlyAccessConfig &&
          version?.earlyAccessConfig?.timeframe &&
          features.earlyAccessModel
            ? version?.earlyAccessConfig
            : null,
        recommendedResources: version.recommendedResources ?? [],
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptsTrainedWords, isTextualInversion, model?.id, version]);

  const maxEarlyAccessModels = getMaxEarlyAccessModels({ userMeta: currentUser?.meta });
  const earlyAccessUnlockedDays = constants.earlyAccess.scoreTimeFrameUnlock
    // TODO: Update to model scores.
    .map(([, days]) =>
      currentUser?.isModerator || days <= getMaxEarlyAccessDays({ userMeta: currentUser?.meta })
        ? days
        : null
    )
    .filter(isDefined);
  const atEarlyAccess = !!version?.earlyAccessEndsAt;
  const isPublished = version?.status === 'Published';
  const showEarlyAccessInput =
    currentUser?.isModerator ||
    (maxEarlyAccessModels > 0 &&
      features.earlyAccessModel &&
      earlyAccessUnlockedDays.length > 0 &&
      (!isPublished || atEarlyAccess));
  const canIncreaseEarlyAccess = version?.status !== 'Published';
  const maxEarlyAccessValue = canIncreaseEarlyAccess
    ? MAX_EARLY_ACCCESS
    : version?.earlyAccessConfig?.timeframe ?? 0;
  const resourceLabel = getDisplayName(model?.type ?? '');
  const modelDownloadEnabled = !usageControl || usageControl === ModelUsageControl.Download;

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

          {features.generationOnlyModels && (
            <>
              <InputSelect
                name="usageControl"
                label="Usage Control"
                description="Determines what other users can do with your model. You can change this setting at any time."
                placeholder="Select how this resource can be used"
                withAsterisk
                style={{ flex: 1 }}
                onChange={(value) => {
                  if (earlyAccessConfig && value !== ModelUsageControl.Download) {
                    // Reset download values:
                    form.setValue('earlyAccessConfig', {
                      ...earlyAccessConfig,
                      chargeForDownload: false,
                      downloadPrice: undefined,
                    });
                  }
                }}
                data={Object.values(ModelUsageControl)
                  .map((x) => ({
                    value: x,
                    label: getDisplayName(x, {
                      overwrites: {
                        [ModelUsageControl.Download]: 'Download & On-Site Generation',
                        [ModelUsageControl.Generation]: 'On-Site Generation Only',
                        [ModelUsageControl.InternalGeneration]: 'Internal API Generation Only',
                      },
                    }),
                  }))
                  .filter(
                    // We don't want random people accessing this.
                    (x) =>
                      x.value !== ModelUsageControl.InternalGeneration || x.value === usageControl
                  )}
              />

              <Alert color="blue" title="Usage Control">
                {modelDownloadEnabled ? (
                  <Text>People will be able to download & generate with this model version.</Text>
                ) : (
                  <Text>
                    People will be able to generate with this model version, but will not be able to
                    download it.
                  </Text>
                )}
              </Alert>
            </>
          )}

          {showEarlyAccessInput && (
            <Stack spacing={0}>
              <Divider label="Early Access Set Up" mb="md" />

              <DismissibleAlert
                id="ea-info"
                size="sm"
                color="yellow"
                title={
                  <Group spacing="xs">
                    <Text>Earn Buzz with early access! </Text>
                    <Popover width={300} withArrow withinPortal shadow="sm">
                      <Popover.Target>
                        <IconInfoCircle size={16} />
                      </Popover.Target>
                      <Popover.Dropdown>
                        <Stack spacing="xs">
                          <Text size="sm">
                            Early Access helps creators monetize, learn more{' '}
                            <Anchor href="/articles/6341">here</Anchor>
                          </Text>
                        </Stack>
                      </Popover.Dropdown>
                    </Popover>
                  </Group>
                }
                content={
                  <Stack>
                    <Text size="xs">
                      Early access allows you to charge a fee for early access to your model. Once
                      the early access period ends, your model will be available to everyone for
                      free.
                    </Text>
                    <Text size="xs">
                      You can have up to {maxEarlyAccessModels} models in early access at a time.
                      This will increase as you post more models on the site.
                    </Text>
                  </Stack>
                }
                mb="xs"
              />
              {isEarlyAccessOver && (
                <Text size="xs" color="red">
                  Early access has ended for this model version. You cannot make changes to early
                  access settings.
                </Text>
              )}
              <Switch
                my="sm"
                label="I want to make this version part of the Early Access Program"
                checked={earlyAccessConfig !== null}
                onChange={(e) =>
                  form.setValue(
                    'earlyAccessConfig',
                    e.target.checked
                      ? {
                          timeframe: constants.earlyAccess.timeframeValues[0],
                          chargeForDownload: modelDownloadEnabled ? true : false,
                          downloadPrice: modelDownloadEnabled ? 5000 : undefined,
                          chargeForGeneration: !modelDownloadEnabled ? true : false,
                          generationPrice: !modelDownloadEnabled ? 2500 : undefined,
                          generationTrialLimit: 10,
                          donationGoalEnabled: false,
                          donationGoal: undefined,
                        }
                      : null
                  )
                }
                disabled={isEarlyAccessOver}
              />
              {earlyAccessConfig && (
                <Stack>
                  <Input.Wrapper
                    label={
                      <Group spacing="xs">
                        <Text weight="bold">Early Access Time Frame</Text>
                        <Popover width={300} withArrow withinPortal shadow="sm">
                          <Popover.Target>
                            <IconInfoCircle size={16} />
                          </Popover.Target>
                          <Popover.Dropdown>
                            <Stack spacing="xs">
                              <Text size="sm">
                                The amount of resources you can have in early access and for how
                                long is determined by actions you&rsquo;ve taken on the site.
                                Increase your limits by posting more free models that people want,
                                being kind, and generally doing good within the community.
                              </Text>
                            </Stack>
                          </Popover.Dropdown>
                        </Popover>
                      </Group>
                    }
                    description="How long would you like to offer early access to your version from the date of publishing?"
                    error={form.formState.errors.earlyAccessConfig?.message}
                  >
                    <SegmentedControl
                      onChange={(value) =>
                        form.setValue('earlyAccessConfig.timeframe', parseInt(value, 10))
                      }
                      value={
                        earlyAccessConfig?.timeframe?.toString() ??
                        constants.earlyAccess.timeframeValues[0]
                      }
                      data={earlyAccessUnlockedDays.map((v) => ({
                        label: `${v} days`,
                        value: v.toString(),
                        disabled: maxEarlyAccessValue < v,
                      }))}
                      color="blue"
                      size="xs"
                      styles={(theme) => ({
                        root: {
                          border: `1px solid ${
                            theme.colorScheme === 'dark'
                              ? theme.colors.dark[4]
                              : theme.colors.gray[4]
                          }`,
                          background: 'none',
                          marginTop: theme.spacing.xs * 0.5, // 5px
                        },
                      })}
                      fullWidth
                      disabled={isEarlyAccessOver}
                    />
                    {earlyAccessUnlockedDays.length !==
                      constants.earlyAccess.timeframeValues.length && (
                      <Group noWrap>
                        <Text size="xs" color="yellow">
                          You will unlock more early access day over time by posting models to the
                          site.
                        </Text>
                      </Group>
                    )}
                    {!canIncreaseEarlyAccess && (
                      <Text size="xs" color="dimmed" mt="sm">
                        You cannot increase early access value after a model has been published
                      </Text>
                    )}
                  </Input.Wrapper>
                  <Stack mt="sm">
                    {modelDownloadEnabled && (
                      <Card withBorder>
                        <Card.Section withBorder>
                          <Group py="sm" px="md" position="apart" noWrap>
                            <div>
                              <Text weight={500} size="sm">
                                Allow users to pay for download (Includes ability to generate)
                              </Text>
                              <Text size="xs">
                                This will require users to pay buzz to download your {resourceLabel}{' '}
                                during the early access period
                              </Text>
                            </div>
                            <InputSwitch
                              name="earlyAccessConfig.chargeForDownload"
                              disabled={isEarlyAccessOver}
                            />
                          </Group>
                        </Card.Section>
                        {earlyAccessConfig?.chargeForDownload && (
                          <Card.Section py="sm" px="md">
                            <InputNumber
                              name="earlyAccessConfig.downloadPrice"
                              label="Download price"
                              description=" How much buzz would you like to charge for your version download?"
                              min={100}
                              max={
                                isPublished
                                  ? version?.earlyAccessConfig?.downloadPrice
                                  : MAX_DONATION_GOAL
                              }
                              step={100}
                              icon={<CurrencyIcon currency="BUZZ" size={16} />}
                              withAsterisk
                              disabled={isEarlyAccessOver}
                            />
                          </Card.Section>
                        )}
                      </Card>
                    )}
                    <Card withBorder>
                      <Card.Section withBorder>
                        <Group py="sm" px="md" position="apart" noWrap>
                          <div>
                            <Text weight={500} size="sm">
                              Allow users to pay for generation only - no download.
                            </Text>
                            <Text size="xs">
                              This will require users to pay buzz to generate with your{' '}
                              {resourceLabel} during the early access period
                            </Text>
                          </div>
                          <InputSwitch
                            name="earlyAccessConfig.chargeForGeneration"
                            disabled={isEarlyAccessOver}
                            onChange={(e) => {
                              if (e.target.checked) {
                                form.setValue(
                                  'earlyAccessConfig.generationPrice',
                                  earlyAccessConfig?.downloadPrice ?? 2500
                                );
                              } else {
                                form.setValue('earlyAccessConfig.generationPrice', undefined);
                              }
                            }}
                          />
                        </Group>
                      </Card.Section>
                      {earlyAccessConfig?.chargeForGeneration && (
                        <Card.Section py="sm" px="md">
                          <Stack>
                            <InputNumber
                              name="earlyAccessConfig.generationPrice"
                              label="Generation price"
                              description="How much would you like to charge to generate with your version?"
                              min={50}
                              max={earlyAccessConfig?.downloadPrice}
                              step={100}
                              icon={<CurrencyIcon currency="BUZZ" size={16} />}
                              disabled={isEarlyAccessOver}
                              withAsterisk
                            />
                            <InputNumber
                              name="earlyAccessConfig.generationTrialLimit"
                              label="Free Trial Limit"
                              description={`Resources in early access require the ability to be tested, please specify how many free tests a user can do prior to purchasing the ${resourceLabel}`}
                              min={10}
                              max={1000}
                              disabled={isEarlyAccessOver}
                              withAsterisk
                            />
                          </Stack>
                        </Card.Section>
                      )}
                    </Card>

                    {(version?.status !== 'Published' ||
                      version?.earlyAccessConfig?.donationGoalId) &&
                      features.donationGoals && (
                        <Card withBorder>
                          <Card.Section withBorder>
                            <Group py="sm" px="md" position="apart" noWrap>
                              <div>
                                <Text weight={500} size="sm">
                                  Enable donation goal
                                </Text>
                                <Text size="xs">
                                  You can use this feature to remove early access once a certain
                                  amount of buzz is met. This will allow you to set a goal for your
                                  model and remove early access once that goal is met.
                                </Text>
                                <Text size="xs">
                                  Please note that after the model is published, you cannot change
                                  this value.
                                </Text>
                              </div>
                              <InputSwitch
                                name="earlyAccessConfig.donationGoalEnabled"
                                disabled={
                                  !!version?.earlyAccessConfig?.donationGoalId || isEarlyAccessOver
                                }
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    form.setValue('earlyAccessConfig.donationGoal', 50000);
                                  } else {
                                    form.setValue('earlyAccessConfig.donationGoal', undefined);
                                  }
                                }}
                              />
                            </Group>
                          </Card.Section>
                          {earlyAccessConfig?.donationGoalEnabled && (
                            <Card.Section py="sm" px="md">
                              <Stack>
                                <InputNumber
                                  name="earlyAccessConfig.donationGoal"
                                  label="Donation Goal Amount"
                                  description="How much Buzz would you like to set as your donation goal? Early access purchases will count towards this goal. After publishing, you cannot change this value"
                                  min={MIN_DONATION_GOAL}
                                  max={MAX_DONATION_GOAL}
                                  step={100}
                                  icon={<CurrencyIcon currency="BUZZ" size={16} />}
                                  disabled={
                                    !!version?.earlyAccessConfig?.donationGoalId ||
                                    isEarlyAccessOver
                                  }
                                />
                              </Stack>
                            </Card.Section>
                          )}
                        </Card>
                      )}
                  </Stack>
                </Stack>
              )}

              {version?.earlyAccessConfig && !earlyAccessConfig && (
                <Text size="xs" color="red">
                  You will not be able to add this model to early access again after removing it.
                  Also, your payment for early access will be lost. Please consider this before
                  removing early access.
                </Text>
              )}
              <Divider my="md" />
            </Stack>
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
          {baseModel === 'SD 3' && (
            <Alert color="yellow" title="SD3 Unsupported">
              <Text>
                On-site generation with SD3 is unsupported.{' '}
                <Text
                  variant="link"
                  td="underline"
                  component="a"
                  target="_blank"
                  href={`/articles/${constants.earlyAccess.article}`}
                >
                  Learn more
                </Text>
              </Text>
            </Alert>
          )}
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
                  selectSource="modelVersion"
                  buttonLabel="Add resource"
                  w="100%"
                  limit={10}
                  options={{
                    resources: [{ type: ModelType.Checkpoint, baseModels: [baseModel] }],
                    excludeIds: recResources.map((r) => r.id),
                  }}
                />
              )}
            </Group>
          </Stack>
          {modelDownloadEnabled && (
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
          )}
        </Stack>
        {children({ loading: upsertVersionMutation.isLoading, canSave })}
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
  earlyAccessEndsAt: Date | null;
  earlyAccessConfig: ModelVersionEarlyAccessConfig | null;
};
type Props = {
  onSubmit: (version?: ModelVersionUpsertInput) => void;
  children: (data: { loading: boolean; canSave: boolean }) => React.ReactNode;
  model?: Partial<ModelUpsertInput & { publishedAt: Date | null }>;
  version?: Partial<VersionInput>;
};
