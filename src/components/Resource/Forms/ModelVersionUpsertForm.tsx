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
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { getQueryKey } from '@trpc/react-query';
import { isEqual, uniq } from 'lodash-es';
import { useRouter } from 'next/router';
import React, { useEffect, useMemo } from 'react';
import * as z from 'zod';

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
  InputCreatableMultiSelect,
  InputNumber,
  InputRTE,
  InputSelect,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  constants,
  EARLY_ACCESS_CONFIG,
  nsfwRestrictedBaseModels,
} from '~/server/common/constants';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { getActiveBaseModels } from '~/shared/constants/basemodel.constants';
import type { ClubResourceSchema } from '~/server/schema/club.schema';
import type { GenerationResourceSchema } from '~/server/schema/generation.schema';
import { generationResourceSchema } from '~/server/schema/generation.schema';
import type {
  ModelVersionEarlyAccessConfig,
  ModelVersionUpsertInput,
  RecommendedSettingsSchema,
} from '~/server/schema/model-version.schema';
import {
  baseModelToTraningDetailsBaseModelMap,
  earlyAccessConfigInput,
  modelVersionUpsertSchema2,
  recommendedSettingsSchema,
} from '~/server/schema/model-version.schema';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import {
  getMaxEarlyAccessDays,
  getMaxEarlyAccessModels,
} from '~/server/utils/early-access-helpers';
import { Availability, ModelType, ModelUsageControl } from '~/shared/utils/prisma/enums';
import type { MyRecentlyRecommended } from '~/types/router';
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
          .refine((v) => EARLY_ACCESS_CONFIG.timeframeValues.some((x) => x === v), {
            error: 'Invalid value',
          }),
      })
      .nullish(),
    useMonetization: z.boolean().default(false),
    recommendedResources: generationResourceSchema
      .merge(recommendedSettingsSchema)
      .array()
      .nullish(),
  })
  .refine((data) => (!data.skipTrainedWords ? (data.trainedWords ?? []).length > 0 : true), {
    error: 'You need to specify at least one trained word',
    path: ['trainedWords'],
  })
  .refine(
    (data) => {
      if (data.settings?.minStrength && data.settings?.maxStrength) {
        return data.settings.minStrength <= data.settings.maxStrength;
      }

      return true;
    },
    { error: 'Min strength must be less than max strength', path: ['settings.minStrength'] }
  )
  .refine(
    (data) => {
      if (data.settings?.minStrength && data.settings.maxStrength) {
        return data.settings.maxStrength >= data.settings.minStrength;
      }

      return true;
    },
    { error: 'Max strength must be greater than min strength', path: ['settings.maxStrength'] }
  )
  .refine(
    (data) => {
      const { generationPrice, downloadPrice } = data.earlyAccessConfig ?? {};
      if (generationPrice && downloadPrice) {
        return generationPrice <= downloadPrice;
      }

      return true;
    },
    { error: 'Generation price cannot be greater than download price', path: ['generationPrice'] }
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
  const colorScheme = useComputedColorScheme('dark');
  const theme = useMantineTheme();

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

  const MAX_EARLY_ACCCESS = 30;

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
              version.earlyAccessConfig?.timeframe ?? EARLY_ACCESS_CONFIG.timeframeValues[0],
          }
        : null,
    modelId: model?.id ?? -1,
    description: version?.description ?? null,
    epochs: version?.epochs ?? null,
    steps: version?.steps ?? null,
    clipSkip: version?.clipSkip ?? null,
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

  // handle mismatched baseModels in training data
  useEffect(() => {
    if (!baseModel) return;
    const value = baseModelToTraningDetailsBaseModelMap[baseModel as keyof typeof baseModelToTraningDetailsBaseModelMap];
    if (value) {
      const { trainingDetails } = form.getValues();
      if (trainingDetails && value !== trainingDetails.baseModel) {
        trainingDetails.baseModel = value;
        form.setValue('trainingDetails', trainingDetails);
      }
    }
  }, [baseModel]);

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
    // Validate NSFW + restricted base model combination
    if (
      model?.nsfw &&
      data.baseModel &&
      nsfwRestrictedBaseModels.includes(data.baseModel as BaseModel)
    ) {
      showErrorNotification({
        error: new Error(
          `NSFW models cannot use base models with license restrictions. The base model "${
            data.baseModel
          }" is restricted for NSFW content. Restricted base models: ${nsfwRestrictedBaseModels.join(
            ', '
          )}`
        ),
        title: 'Base Model License Restriction',
      });
      return;
    }

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
        earlyAccessConfig:
          model?.availability === Availability.Private || !data.earlyAccessConfig
            ? null
            : data.earlyAccessConfig,
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

  const maxEarlyAccessModels = getMaxEarlyAccessModels({ userMeta: currentUser?.meta, features });
  const earlyAccessUnlockedDays = EARLY_ACCESS_CONFIG.scoreTimeFrameUnlock
    // TODO: Update to model scores.
    .map((data) => {
      const [, days] = data;
      return currentUser?.isModerator ||
        days <= getMaxEarlyAccessDays({ userMeta: currentUser?.meta, features })
        ? days
        : null;
    })
    .filter(isDefined);

  const atEarlyAccess = !!version?.earlyAccessEndsAt;
  const isPublished = version?.status === 'Published';
  const isPrivateModel = model?.availability === Availability.Private;
  const showEarlyAccessInput =
    !model?.poi && // POI models won't allow EA.
    !isPrivateModel &&
    (currentUser?.isModerator ||
      (maxEarlyAccessModels > 0 &&
        features.earlyAccessModel &&
        earlyAccessUnlockedDays.length > 0 &&
        (!isPublished || atEarlyAccess)));
  const canIncreaseEarlyAccess = version?.status !== 'Published';
  const maxEarlyAccessValue = canIncreaseEarlyAccess
    ? MAX_EARLY_ACCCESS
    : version?.earlyAccessConfig?.timeframe ?? 0;
  const resourceLabel = getDisplayName(model?.type ?? '');
  const modelDownloadEnabled = !usageControl || usageControl === ModelUsageControl.Download;

  // Check if current base model selection violates NSFW restrictions
  const hasNsfwBaseModelViolation =
    model?.nsfw && baseModel && nsfwRestrictedBaseModels.includes(baseModel as BaseModel);

  const canSave = !hasNsfwBaseModelViolation;

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

          {features.generationOnlyModels && !isPrivateModel && (
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
                allowDeselect={false}
              />

              <Alert color="blue">
                {modelDownloadEnabled ? (
                  <Text>People will be able to download & generate with this model version.</Text>
                ) : (
                  <Text>
                    People will be able to generate with this model version, but will{' '}
                    <span className="underline">not</span> be able to download it.
                  </Text>
                )}
              </Alert>
            </>
          )}

          {showEarlyAccessInput && (
            <Stack gap={0}>
              <Divider label="Early Access Set Up" mb="md" />

              <DismissibleAlert
                id="ea-info"
                size="sm"
                color="yellow"
                title={
                  <Group gap="xs">
                    <Text>Earn Buzz with early access! </Text>
                    <Popover width={300} withArrow withinPortal shadow="sm">
                      <Popover.Target>
                        <IconInfoCircle size={16} />
                      </Popover.Target>
                      <Popover.Dropdown>
                        <Stack gap="xs">
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
                <Text size="xs" c="red">
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
                          timeframe: EARLY_ACCESS_CONFIG.timeframeValues[0],
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
                      <Group gap="xs">
                        <Text fw="bold">Early Access Time Frame</Text>
                        <Popover width={300} withArrow withinPortal shadow="sm">
                          <Popover.Target>
                            <IconInfoCircle size={16} />
                          </Popover.Target>
                          <Popover.Dropdown>
                            <Stack gap="xs">
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
                        EARLY_ACCESS_CONFIG.timeframeValues[0]
                      }
                      data={earlyAccessUnlockedDays.map((v) => ({
                        label: `${v} days`,
                        value: v.toString(),
                        disabled: maxEarlyAccessValue < v,
                      }))}
                      color="blue"
                      size="xs"
                      styles={{
                        root: {
                          border: `1px solid ${
                            colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
                          }`,
                          background: 'none',
                          marginTop: 'calc(var(--mantine-spacing-xs) * 0.5)', // 5px
                        },
                      }}
                      fullWidth
                      disabled={isEarlyAccessOver}
                    />
                    {earlyAccessUnlockedDays.length !==
                      EARLY_ACCESS_CONFIG.timeframeValues.length && (
                      <Group wrap="nowrap">
                        <Text size="xs" c="yellow">
                          You will unlock more early access day over time by posting models to the
                          site.
                        </Text>
                      </Group>
                    )}
                    {!canIncreaseEarlyAccess && (
                      <Text size="xs" c="dimmed" mt="sm">
                        You cannot increase early access value after a model has been published
                      </Text>
                    )}
                  </Input.Wrapper>
                  <Stack mt="sm">
                    {modelDownloadEnabled && (
                      <Card withBorder>
                        <Card.Section withBorder>
                          <Group py="sm" px="md" justify="space-between" wrap="nowrap">
                            <div>
                              <Text fw={500} size="sm">
                                Allow users to pay for download (Includes ability to generate)
                              </Text>
                              <Text size="xs">
                                This will require users to pay Buzz to download your {resourceLabel}{' '}
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
                              description=" How much Buzz would you like to charge for your version download?"
                              min={100}
                              max={
                                isPublished
                                  ? version?.earlyAccessConfig?.downloadPrice
                                  : MAX_DONATION_GOAL
                              }
                              step={100}
                              leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                              withAsterisk
                              disabled={isEarlyAccessOver}
                            />
                          </Card.Section>
                        )}
                      </Card>
                    )}
                    <Card withBorder>
                      <Card.Section withBorder>
                        <Group py="sm" px="md" justify="space-between" wrap="nowrap">
                          <div>
                            <Text fw={500} size="sm">
                              Allow users to pay for generation only - no download.
                            </Text>
                            <Text size="xs">
                              This will require users to pay Buzz to generate with your{' '}
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
                              leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
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
                            <Group py="sm" px="md" justify="space-between" wrap="nowrap">
                              <div>
                                <Text fw={500} size="sm">
                                  Enable donation goal
                                </Text>
                                <Text size="xs">
                                  You can use this feature to remove early access once a certain
                                  amount of Buzz is met. This will allow you to set a goal for your
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
                                  leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
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
                <Text size="xs" c="red">
                  You will not be able to add this model to early access again after removing it.
                  Also, your payment for early access will be lost. Please consider this before
                  removing early access.
                </Text>
              )}
              <Divider my="md" />
            </Stack>
          )}
          <Group gap="xs" grow>
            <InputSelect
              name="baseModel"
              label="Base Model"
              placeholder="Base Model"
              style={{ flex: 1 }}
              data={getActiveBaseModels(currentUser?.isModerator).map((x) => ({
                value: x.name,
                label: x.name,
              }))}
              allowDeselect={false}
              withAsterisk
            />
            {hasBaseModelType && (
              <InputSelect
                name="baseModelType"
                label="Base Model Type"
                placeholder="Base Model Type"
                data={baseModelTypeOptions}
                allowDeselect={false}
              />
            )}
          </Group>
          {hasNsfwBaseModelViolation && (
            <Alert color="red" title="License Restriction Violation">
              <Text size="sm">
                NSFW models cannot use base models with license restrictions. The selected base
                model does not permit NSFW content. Please select a different base model.
              </Text>
              <Text size="sm" mt="xs">
                Restricted base models: {nsfwRestrictedBaseModels.join(', ')}
              </Text>
            </Alert>
          )}
          {baseModel === 'SD 3' && (
            <Alert color="yellow" title="SD3 Unsupported">
              <Text>
                On-site generation with SD3 is unsupported.{' '}
                <Text
                  td="underline"
                  component="a"
                  target="_blank"
                  href={`/articles/${EARLY_ACCESS_CONFIG.article}`}
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
            <Stack gap="xs">
              {!skipTrainedWords && (
                <InputCreatableMultiSelect
                  name="trainedWords"
                  label="Trigger Words"
                  placeholder="e.g.: Master Chief"
                  description={`Please input the words you have trained your model with${
                    isTextualInversion ? ' (max 1 word)' : ''
                  }`}
                  data={trainedWords}
                  maxValues={isTextualInversion ? 1 : undefined}
                  clearable
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
          <Stack gap={4}>
            <Divider label="Training Params" />
            <Group gap="xs" grow>
              <InputNumber
                name="epochs"
                label="Epochs"
                placeholder="Training Epochs"
                min={0}
                max={100000}
                style={{ flexGrow: 1 }}
              />
              <InputNumber
                name="steps"
                label="Steps"
                placeholder="Training Steps"
                min={0}
                step={500}
                style={{ flexGrow: 1 }}
              />
            </Group>
          </Stack>
          <Stack gap={4}>
            <Divider label="Recommended Settings" />
            <Group gap="xs" className="*:grow">
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
                    decimalScale={1}
                    step={0.1}
                  />
                  <InputNumber
                    name="settings.maxStrength"
                    label="Max Strength"
                    min={-100}
                    max={100}
                    decimalScale={1}
                    step={0.1}
                  />
                  <InputNumber
                    name="settings.strength"
                    label="Strength"
                    min={minStrength ?? -1}
                    max={maxStrength ?? 2}
                    decimalScale={1}
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
            <Stack gap={8}>
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
