import {
  Alert,
  Anchor,
  Card,
  Divider,
  Group,
  Input,
  NumberInput,
  Popover,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { getQueryKey } from '@trpc/react-query';
import { isEqual, uniq } from 'lodash-es';
import { useRouter } from 'next/router';
import React, { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_FEE_IMAGES,
  FEE_IMAGE_OPTIONS,
  feeToRatio,
  isTimedWindowOver,
  maxPermanentAccessModels,
} from '@civitai/buzz';
import * as z from 'zod';

import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import InputResourceSelectMultiple from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import {
  MAX_DONATION_GOAL,
  MIN_DONATION_GOAL,
} from '~/components/Model/ModelVersions/model-version.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useCreatorProgramRequirements } from '~/components/Buzz/CreatorProgramV2/CreatorProgram.util';
import { useCurrentUserSettings, useMutateUserSettings } from '~/components/UserSettings/hooks';
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
import { Flags } from '~/shared/utils/flags';
import { ModelVersionFlag } from '~/shared/constants/model-version-flags.constants';
import {
  constants,
  EARLY_ACCESS_CONFIG,
  isNonCommercialBaseModel,
  nsfwRestrictedBaseModels,
} from '~/server/common/constants';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import {
  baseModelSupportsClipSkip,
  defaultBaseModel,
  getActiveBaseModels,
} from '~/shared/constants/basemodel.constants';
import { useLastUsedBaseModelStore } from '~/store/last-used-base-model.store';
import type { GenerationResourceSchema } from '~/server/schema/generation.schema';
import { generationResourceSchema } from '~/server/schema/generation.schema';
import type {
  ModelVersionEarlyAccessConfig,
  ModelVersionMeta,
  ModelVersionUpsertInput,
  RecommendedSettingsSchema,
} from '~/server/schema/model-version.schema';
import {
  baseModelToTraningDetailsBaseModelMap,
  earlyAccessConfigInput,
  MAX_LICENSING_FEE,
  modelVersionUpsertSchema2,
  recommendedSettingsSchema,
} from '~/server/schema/model-version.schema';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import {
  getMaxEarlyAccessDays,
  getMaxEarlyAccessModels,
} from '~/server/utils/early-access-helpers';
import {
  Availability,
  LicensingFeeSettlementCurrency,
  ModelType,
  ModelUsageControl,
} from '~/shared/utils/prisma/enums';
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
        // 0 is only valid for permanent access (which is intentionally duration-0); the object-level
        // refine below rejects it for a timed window.
        timeframe: z
          .number()
          .refine((v) => v === 0 || EARLY_ACCESS_CONFIG.timeframeValues.some((x) => x === v), {
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
  )
  .refine(
    (data) => {
      const config = data.earlyAccessConfig;
      // Permanent access is duration-0; a timed window must pick an unlocked value.
      if (!config || config.permanent) return true;
      return EARLY_ACCESS_CONFIG.timeframeValues.some((x) => x === config.timeframe);
    },
    { error: 'Invalid value', path: ['earlyAccessConfig', 'timeframe'] }
  );
type Schema = z.infer<typeof schema>;

const baseModelTypeOptions = constants.baseModelTypes.map((x) => ({ label: x, value: x }));
const capitalizeFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const licensingOptionLabel = (versionName: string, fee: number | null) =>
  `${capitalizeFirst(versionName)}${fee != null ? ` (${fee} Buzz)` : ''}`;
const querySchema = z.object({
  templateId: z.coerce.number().optional(),
  bountyId: z.coerce.number().optional(),
});

export function ModelVersionUpsertForm({
  id,
  model,
  version,
  previousBaseModel,
  children,
  onSubmit,
  afterName,
}: Props) {
  const features = useFeatureFlags();
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const { hideDonationGoals } = useCurrentUserSettings();
  const { mutate: mutateUserSettings, isPending: hideDonationGoalsUpdating } =
    useMutateUserSettings();
  const { requirements } = useCreatorProgramRequirements();
  const isActiveCreatorMember = !!requirements?.validMembership;
  const lastUsedBaseModel = useLastUsedBaseModelStore((s) => s.lastUsedBaseModel);
  const setLastUsedBaseModel = useLastUsedBaseModelStore((s) => s.setLastUsedBaseModel);
  // For a brand-new version, seed the base model from the previous version (if any),
  // then the user's last-used selection, then the global default.
  const initialBaseModel =
    version?.baseModel ?? previousBaseModel ?? lastUsedBaseModel ?? defaultBaseModel;
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
  const showStrengthInput = ['LORA', 'Hypernetwork', 'LoCon', 'DoRA'].includes(model?.type ?? '');
  // "The timed window has elapsed" — deliberately NOT true for permanent access, which has no window at all.
  // Testing `earlyAccessEndsAt` directly would report every permanent version as expired and disable its
  // controls after publishing.
  const isEarlyAccessOver =
    version?.status === 'Published' &&
    isTimedWindowOver({
      earlyAccessEndsAt: version?.earlyAccessEndsAt,
      // The form only carries the config; the DB column is derived from this same flag by the trigger.
      permanent: version?.earlyAccessConfig?.permanent,
    });

  const MAX_EARLY_ACCCESS = 30;

  const defaultValues: Schema = {
    ...version,
    name: version?.name ?? 'v1.0',
    baseModel: initialBaseModel,
    baseModelType: hasBaseModelType ? version?.baseModelType ?? 'Standard' : undefined,
    trainedWords: version?.trainedWords ?? [],
    skipTrainedWords: acceptsTrainedWords
      ? version?.trainedWords
        ? !version.trainedWords.length
        : false
      : true,
    // Permanent access is deliberately `timeframe: 0`, so testing the timeframe for truthiness would drop the
    // config on load — and saving would then clear the paid gate. Keep it whenever either mode is configured.
    // The `earlyAccessModel` flag only gates the timed window; permanent is gated by membership tier instead.
    earlyAccessConfig:
      version?.earlyAccessConfig &&
      (version.earlyAccessConfig.permanent ||
        (!!version.earlyAccessConfig.timeframe && features.earlyAccessModel))
        ? {
            ...version.earlyAccessConfig,
            timeframe: version.earlyAccessConfig.permanent
              ? 0
              : version.earlyAccessConfig.timeframe ?? EARLY_ACCESS_CONFIG.timeframeValues[0],
          }
        : null,
    modelId: model?.id ?? -1,
    description: version?.description ?? null,
    epochs: version?.epochs ?? null,
    steps: version?.steps ?? null,
    clipSkip: version?.clipSkip ?? null,
    useMonetization: !!version?.monetization,
    monetization: version?.monetization ?? null,
    licensingFee: Number(version?.licensingFee ?? 0),
    licensingFeeType: version?.licensingFeeType ?? null,
    licensingFeeSettlementCurrency: version?.licensingFeeSettlementCurrency ?? null,
    licensingSourceVersionId: version?.licensingSourceVersionId ?? null,
    requireAuth: version?.requireAuth ?? true,
    recommendedResources: version?.recommendedResources ?? [],
    // Being extra safe here and ensuring this value exists.
    usageControl: !!version?.usageControl
      ? version?.usageControl ?? ModelUsageControl.Download
      : ModelUsageControl.Download,
    meta: {
      hideBuzz: (version?.meta as ModelVersionMeta | null)?.hideBuzz ?? false,
      hideDownloads: (version?.meta as ModelVersionMeta | null)?.hideDownloads ?? false,
      hideGenerations: (version?.meta as ModelVersionMeta | null)?.hideGenerations ?? false,
    },
  };

  const form = useForm({ schema, defaultValues, shouldUnregister: false, mode: 'onChange' });

  const skipTrainedWords = !isTextualInversion && (form.watch('skipTrainedWords') ?? false);
  const trainedWords = form.watch('trainedWords') ?? [];
  const baseModel = form.watch('baseModel') ?? initialBaseModel;
  // Non-commercial base models (e.g. Ideogram) can't be monetized — hide the
  // licensing-fee and early-access controls for these versions.
  const isNonCommercial = isNonCommercialBaseModel(baseModel);
  const recResources = form.watch('recommendedResources') ?? [];
  // Clip skip only applies to SD1.x / SDXL-family base models — hide it elsewhere.
  const showClipSkip = baseModelSupportsClipSkip(baseModel);
  // Recommended Resources clutter the form; only surface the section when the
  // version already has recommended resources set.
  const showRecommendedResources = recResources.length > 0;
  const [minStrength, maxStrength] = form.watch([
    'settings.minStrength',
    'settings.maxStrength',
  ]) as number[];
  const { isDirty } = form.formState;
  const earlyAccessConfig = form.watch('earlyAccessConfig');
  const usageControl = form.watch('usageControl');
  const currentLicensingFee = form.watch('licensingFee') ?? 0;
  // Creators price as a whole-number ratio ("1 Buzz per 10 images"), matching Creator Studio; the stored value
  // stays the per-image decimal. Only the denominator is local state — the numerator derives from the stored
  // fee, so an external reset (e.g. the non-commercial clear below) flows through without going stale.
  const [feeImages, setFeeImages] = useState<number>(
    () => feeToRatio(Number(version?.licensingFee ?? 0)).images
  );
  const feeBuzz = Math.round(Number(currentLicensingFee ?? 0) * feeImages * 100) / 100;
  // Clamp here, not just on the inputs: changing the denominator keeps the numerator, so 500-per-10 becoming
  // 500-per-1 would otherwise write 500 and fail the schema's max with no visible error.
  const setFeeFromRatio = (buzz: number, images: number) =>
    form.setValue(
      'licensingFee',
      images > 0 ? Math.min(MAX_LICENSING_FEE, Math.round((buzz / images) * 100) / 100) : 0,
      { shouldDirty: true, shouldValidate: true }
    );
  const existingSettlementCurrency = version?.licensingFeeSettlementCurrency ?? null;
  const hasExistingLicensingFee = Number(version?.licensingFee ?? 0) > 0;
  const showLicensingFeeBlock =
    !isNonCommercial &&
    (!!features.licensingFee ||
      hasExistingLicensingFee ||
      existingSettlementCurrency === LicensingFeeSettlementCurrency.Cash);
  const showLicensingFeeSettlementCurrency =
    existingSettlementCurrency === LicensingFeeSettlementCurrency.Cash ||
    !!currentUser?.isModerator;

  const licensingSourceVersionId = form.watch('licensingSourceVersionId') ?? null;
  const { data: licensingRootsData } = trpc.modelVersion.getLicensingRoots.useQuery(
    { baseModel, modelType: model?.type },
    { enabled: !!baseModel }
  );
  const defaultLicensingSourceId = licensingRootsData?.defaultVersionId ?? null;
  // A version that is itself a licensing root is the source, so it doesn't pick a parent.
  const currentIsLicensingRoot = (licensingRootsData?.roots ?? []).some(
    (r) => r.id === version?.id
  );
  // Versions flagged NotDerivative (e.g. API-only official checkpoints) aren't
  // fine-tunes, so the form doesn't require/auto-select a parent for them. They
  // can still set their own licensing fee via the fee field above.
  const notDerivative = Flags.hasFlag(version?.flags ?? 0, ModelVersionFlag.NotDerivative);
  // Exclude only the version being edited (a root can't point at itself). The
  // default root is a normal, pre-selected option — there is no null "Default".
  const licensingRoots = (licensingRootsData?.roots ?? []).filter((r) => r.id !== version?.id);
  const showLicensingPicker =
    licensingRoots.length > 0 && !currentIsLicensingRoot && !notDerivative;

  // A base-model change invalidates the selected source (roots are base-scoped);
  // the default effect below re-selects the new base's default.
  const prevBaseModelRef = useRef(baseModel);
  useEffect(() => {
    if (prevBaseModelRef.current === baseModel) return;
    prevBaseModelRef.current = baseModel;
    if (form.getValues('licensingSourceVersionId') != null)
      form.setValue('licensingSourceVersionId', null, { shouldDirty: true });
  }, [baseModel]);

  // A derivative must record an explicit parent — a null source means no fee, so
  // pre-select the ecosystem's default root when none is set. Skipped for roots
  // and exempt versions (which legitimately have no parent).
  useEffect(() => {
    if (currentIsLicensingRoot || notDerivative) return;
    if (defaultLicensingSourceId == null) return;
    if (form.getValues('licensingSourceVersionId') == null)
      form.setValue('licensingSourceVersionId', defaultLicensingSourceId, { shouldDirty: false });
  }, [defaultLicensingSourceId, currentIsLicensingRoot, notDerivative]);

  // handle mismatched baseModels in training data
  useEffect(() => {
    if (!baseModel) return;
    const value =
      baseModelToTraningDetailsBaseModelMap[
        baseModel as keyof typeof baseModelToTraningDetailsBaseModelMap
      ];
    if (value) {
      const { trainingDetails } = form.getValues();
      if (trainingDetails && value !== trainingDetails.baseModel) {
        trainingDetails.baseModel = value;
        form.setValue('trainingDetails', trainingDetails);
      }
    }
  }, [baseModel]);

  // Non-commercial base models can't be monetized. The monetization controls are
  // hidden (shouldUnregister is false, so their values would otherwise persist and
  // be re-submitted, then rejected server-side with a confusing error). Clear them
  // when switching to such a base model so the form can save.
  useEffect(() => {
    if (!isNonCommercial) return;
    if ((form.getValues('licensingFee') ?? 0) > 0) form.setValue('licensingFee', 0);
    if (form.getValues('monetization')) form.setValue('monetization', null);
    if (form.getValues('earlyAccessConfig')) form.setValue('earlyAccessConfig', null);
    if (form.getValues('useMonetization')) form.setValue('useMonetization', false);
  }, [isNonCommercial]);

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

    if (data.baseModel) setLastUsedBaseModel(data.baseModel);

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
        // Don't persist a stale clip skip for base models that don't use it.
        clipSkip: showClipSkip ? data.clipSkip ?? null : null,
        epochs: data.epochs ?? null,
        steps: data.steps ?? null,
        modelId: model?.id ?? -1,
        earlyAccessConfig:
          model?.availability === Availability.Private || !data.earlyAccessConfig
            ? null
            : data.earlyAccessConfig,
        trainedWords: skipTrainedWords ? [] : trainedWords,
        baseModelType: hasBaseModelType ? data.baseModelType : undefined,
        monetization: data.monetization,
        recommendedResources,
        templateId,
        bountyId,
      });

      await queryUtils.modelVersion.getById.invalidate({ id: result.id, withFiles: true });
      await queryUtils.modelVersion.getById.invalidate({ id: result.id });
      await queryUtils.modelVersion.getByIdForEdit.invalidate({ id: result.id, withFiles: true });
      await queryUtils.modelVersion.getByIdForEdit.invalidate({ id: result.id });
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
    if (version) {
      // Re-seed the ratio denominator alongside the fee — the numerator is derived from it, so a stale
      // denominator would render the wrong Buzz amount when `version` resolves after mount.
      setFeeImages(feeToRatio(Number(version.licensingFee ?? 0)).images);
      form.reset({
        ...version,
        licensingFee: Number(version.licensingFee ?? 0),
        modelId: version.modelId ?? model?.id ?? -1,
        baseModel: version.baseModel,
        skipTrainedWords: isTextualInversion
          ? false
          : acceptsTrainedWords
          ? version?.trainedWords
            ? !version.trainedWords.length
            : false
          : true,
        // Same presence rule as defaultValues — permanent is timeframe-0, so a truthiness test would wipe it.
        earlyAccessConfig:
          version?.earlyAccessConfig &&
          (version.earlyAccessConfig.permanent ||
            (!!version.earlyAccessConfig.timeframe && features.earlyAccessModel))
            ? version.earlyAccessConfig
            : null,
        recommendedResources: version.recommendedResources ?? [],
        meta: {
          hideBuzz: (version.meta as ModelVersionMeta | null)?.hideBuzz ?? false,
          hideDownloads: (version.meta as ModelVersionMeta | null)?.hideDownloads ?? false,
          hideGenerations: (version.meta as ModelVersionMeta | null)?.hideGenerations ?? false,
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptsTrainedWords, isTextualInversion, model?.id, version]);

  const maxEarlyAccessModels = getMaxEarlyAccessModels({ userMeta: currentUser?.meta, features });
  // Permanent access replaces the timed window (it is duration-0) and is capped per Creator-Program tier —
  // `validMembership` is the tier string when valid, `false` otherwise. The cap is enforced server-side; this
  // only sets expectations. `Infinity` (gold) reads as "unlimited".
  const isPermanentAccess = !!earlyAccessConfig?.permanent;
  // `isEarlyAccessOver` reads the *saved* version; this tracks the live form value so the price fields unlock
  // as soon as permanent is switched on, not only after a save.
  const timedControlsLocked = isEarlyAccessOver && !isPermanentAccess;
  const permanentTier =
    typeof requirements?.validMembership === 'string' ? requirements.validMembership : null;
  const maxPermanentModels = maxPermanentAccessModels(permanentTier);
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
  const seedPermanentAccess = isEarlyAccessOver || earlyAccessUnlockedDays.length === 0;

  const atEarlyAccess = !!version?.earlyAccessEndsAt;
  const isPublished = version?.status === 'Published';
  const isPrivateModel = model?.availability === Availability.Private;
  // Permanent access is not a window anchored to publishing, and it is gated by Creator-Program tier rather
  // than the score-based early-access unlocks — so it stays available after publishing and without EA days.
  const canSetPermanentAccess = !!currentUser?.isModerator || maxPermanentModels > 0;
  const showEarlyAccessInput =
    !model?.poi && // POI models won't allow EA.
    !isPrivateModel &&
    !isNonCommercial && // Non-commercial base models can't be monetized.
    (currentUser?.isModerator ||
      canSetPermanentAccess ||
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
      <Form id={id} form={form} onSubmit={handleSubmit}>
        <Stack>
          <InputText
            name="name"
            label="Name"
            placeholder="e.g.: v1.0"
            withAsterisk
            maxLength={25}
          />
          {afterName}

          {features.generationOnlyModels && (!isPrivateModel || currentUser?.isModerator) && (
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
                        [ModelUsageControl.ExternalGeneration]:
                          'External API Generation (no files)',
                      },
                    }),
                  }))
                  .filter(
                    // Mod-only options: hide unless already selected or user is a moderator.
                    (x) =>
                      (x.value !== ModelUsageControl.InternalGeneration &&
                        x.value !== ModelUsageControl.ExternalGeneration) ||
                      x.value === usageControl ||
                      currentUser?.isModerator
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
              <Divider label="Paid Access Set Up" mb="md" />

              <DismissibleAlert
                id="ea-info"
                size="sm"
                color="yellow"
                title={
                  <Group gap="xs">
                    <Text>Earn Buzz by charging for access! </Text>
                    <Popover width={300} withArrow withinPortal shadow="sm">
                      <Popover.Target>
                        <IconInfoCircle size={16} />
                      </Popover.Target>
                      <Popover.Dropdown>
                        <Stack gap="xs">
                          <Text size="sm">
                            Paid access helps creators monetize, learn more{' '}
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
                      Charge a fee for access to this version: a timed early access window, which
                      becomes free for everyone once it ends, or permanent access, which never does.
                    </Text>
                    <Text size="xs">
                      You can have up to {maxEarlyAccessModels} versions in timed early access at a
                      time — this increases as you post more models on the site. Permanent access is
                      limited by your Creator Program membership tier.
                    </Text>
                  </Stack>
                }
                mb="xs"
              />
              {isEarlyAccessOver && (
                <Text size="xs" c={canSetPermanentAccess ? 'dimmed' : 'red'}>
                  {canSetPermanentAccess
                    ? 'The timed early access window has ended for this version, but you can still sell permanent access to it.'
                    : 'Early access has ended for this model version. You cannot make changes to early access settings.'}
                </Text>
              )}
              <Switch
                my="sm"
                label="I want to charge for access to this version"
                checked={earlyAccessConfig !== null}
                onChange={(e) =>
                  form.setValue(
                    'earlyAccessConfig',
                    e.target.checked
                      ? {
                          // Seed permanent when a timed window isn't actually available: after publishing
                          // (the window runs from the publish date) or with no score-unlocked days, where
                          // the timeframe control would render empty and fail validation.
                          permanent: seedPermanentAccess,
                          timeframe: seedPermanentAccess
                            ? 0
                            : EARLY_ACCESS_CONFIG.timeframeValues[0],
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
                disabled={isEarlyAccessOver && !canSetPermanentAccess}
              />
              {earlyAccessConfig && (
                <Stack>
                  <Input.Wrapper
                    label={<Text fw="bold">Permanent Paid Access</Text>}
                    description="Sell access with no end date instead of a timed early access window. Buyers keep what they paid for, and the version never becomes free."
                  >
                    <Switch
                      mt="xs"
                      checked={isPermanentAccess}
                      onChange={(event) => {
                        const permanent = event.currentTarget.checked;
                        form.setValue('earlyAccessConfig.permanent', permanent);
                        // Permanent is duration-0; restore a valid window when switching back.
                        form.setValue(
                          'earlyAccessConfig.timeframe',
                          permanent ? 0 : EARLY_ACCESS_CONFIG.timeframeValues[0]
                        );
                      }}
                      // Stays editable after publishing — unlike a timed window, permanent has no start
                      // date. It can't be swapped back to a window post-publish though; the toggle above
                      // removes paid access entirely.
                      disabled={
                        (!canSetPermanentAccess && !isPermanentAccess) ||
                        (isEarlyAccessOver && isPermanentAccess)
                      }
                      label={
                        !canSetPermanentAccess
                          ? 'Requires an active Creator Program membership.'
                          : maxPermanentModels <= 0
                          ? 'Moderator override — normally requires a Creator Program membership.'
                          : `Your membership allows ${
                              Number.isFinite(maxPermanentModels) ? maxPermanentModels : 'unlimited'
                            } permanent ${maxPermanentModels === 1 ? 'version' : 'versions'}.`
                      }
                    />
                    {isEarlyAccessOver && isPermanentAccess && (
                      <Text size="xs" c="dimmed" mt="xs">
                        A timed early access window can&rsquo;t be started after publishing. Turn
                        off the option above to remove paid access entirely.
                      </Text>
                    )}
                  </Input.Wrapper>
                  {!isPermanentAccess && !isEarlyAccessOver && (
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
                        disabled={timedControlsLocked}
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
                  )}
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
                              disabled={timedControlsLocked}
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
                              disabled={timedControlsLocked}
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
                            disabled={timedControlsLocked}
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
                              disabled={timedControlsLocked}
                              withAsterisk
                            />
                            <InputNumber
                              name="earlyAccessConfig.generationTrialLimit"
                              label="Free Trial Limit"
                              description={`Resources in early access require the ability to be tested, please specify how many free tests a user can do prior to purchasing the ${resourceLabel}`}
                              min={10}
                              max={1000}
                              disabled={timedControlsLocked}
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
                                // Mirrors the server rule (mergeEarlyAccessConfig): donation goals are frozen
                                // once published, regardless of access mode.
                                disabled={
                                  !!version?.earlyAccessConfig?.donationGoalId || isPublished
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
                                    !!version?.earlyAccessConfig?.donationGoalId || isPublished
                                  }
                                />
                                <Switch
                                  label="Hide donation goals from public view"
                                  description="Others won't see the progress bar or collected amount. The goal still works, and you and moderators can still see it. This applies to all of your donation goals."
                                  checked={hideDonationGoals ?? false}
                                  onChange={(e) =>
                                    mutateUserSettings({ hideDonationGoals: e.target.checked })
                                  }
                                  disabled={hideDonationGoalsUpdating}
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
          {showLicensingFeeBlock && (
            <Stack gap="xs">
              <Input.Wrapper
                label="License Fee"
                description={`Charge a fee for generations using this version. If this is a derivative of a base model that already charges a licensing fee, your fee is added on top of it. Set to 0 to disable. Max ${MAX_LICENSING_FEE} Buzz per image.`}
                error={form.formState.errors.licensingFee?.message}
              >
                <Group gap="xs" wrap="nowrap" mt={4}>
                  <NumberInput
                    aria-label="Buzz per images"
                    value={feeBuzz}
                    onChange={(value) =>
                      setFeeFromRatio(
                        typeof value === 'number' ? value : Number(value) || 0,
                        feeImages
                      )
                    }
                    min={0}
                    max={MAX_LICENSING_FEE * feeImages}
                    step={1}
                    decimalScale={0}
                    allowNegative={false}
                    leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                    w={120}
                  />
                  <Text size="sm" c="dimmed">
                    per
                  </Text>
                  <Select
                    aria-label="Images per fee"
                    data={FEE_IMAGE_OPTIONS.map((count) => ({
                      value: String(count),
                      label: count === 1 ? '1 image' : `${count} images`,
                    }))}
                    value={String(feeImages)}
                    onChange={(value) => {
                      const images = Number(value) || DEFAULT_FEE_IMAGES;
                      setFeeImages(images);
                      setFeeFromRatio(feeBuzz, images);
                    }}
                    allowDeselect={false}
                    w={140}
                  />
                </Group>
              </Input.Wrapper>
              {feeBuzz > 0 && (
                <Text size="xs" c="dimmed">
                  Charged as {currentLicensingFee} Buzz per image.
                </Text>
              )}
              {showLicensingFeeSettlementCurrency && (
                <InputSelect
                  name="licensingFeeSettlementCurrency"
                  label="Settlement Currency"
                  description="Currency used to pay you out for license fees. Cash settlement is restricted; contact support to enable."
                  data={[
                    { value: LicensingFeeSettlementCurrency.Buzz, label: 'Buzz' },
                    { value: LicensingFeeSettlementCurrency.Cash, label: 'Cash' },
                  ]}
                  allowDeselect={false}
                />
              )}
              {currentLicensingFee > 0 && (
                <Group gap="xs" wrap="nowrap" align="flex-start">
                  <IconAlertTriangle
                    size={14}
                    className="text-yellow-500"
                    style={{ flexShrink: 0, marginTop: 2 }}
                  />
                  <Text size="xs" c="yellow">
                    With a license fee set, this version stops earning creator compensation and tips
                    — you earn through the license fee instead.
                  </Text>
                </Group>
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
              searchable
              // Select the current value on focus so the user can click and immediately
              // type to filter (e.g. "wan") instead of clearing the field first.
              onFocus={(e) => e.currentTarget.select()}
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
          {showLicensingPicker && (
            <Stack gap="xs">
              <Select
                label="Fine-tuned from"
                description="Select the parent model this version was fine-tuned from. Its licensing fee applies to generations made with your model."
                placeholder="Select a parent model"
                allowDeselect={false}
                comboboxProps={{ withinPortal: true }}
                value={licensingSourceVersionId ? String(licensingSourceVersionId) : null}
                onChange={(val) =>
                  form.setValue('licensingSourceVersionId', val ? Number(val) : null, {
                    shouldDirty: true,
                  })
                }
                data={licensingRoots.map((r) => ({
                  value: String(r.id),
                  label: licensingOptionLabel(r.versionName, r.licensingFee),
                }))}
              />
            </Stack>
          )}
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
          {isNonCommercial && (
            <Alert color="yellow" title="Non-commercial base model">
              <Text>
                {baseModel} is licensed for non-commercial use only. This version cannot be
                monetized (no licensing fees or paid early access) and commercial use is disabled.
              </Text>
            </Alert>
          )}
          <InputRTE
            key="description"
            name="description"
            label="Version changes or notes"
            includeControls={['formatting', 'list', 'link']}
            editorSize="xl"
          />
          <Stack gap="xs">
            <Divider label="Version metric privacy" />
            <Text size="xs" c="dimmed">
              Hide these stats in this version&apos;s details card. This is a sub-option of the
              model-level controls — hiding at the model level already hides the model page totals
              and cards.{' '}
              {isActiveCreatorMember
                ? 'You and moderators always see your real stats.'
                : 'Requires an active Creator Program membership.'}
            </Text>
            <InputSwitch
              name="meta.hideBuzz"
              label="Hide earned Buzz"
              disabled={!isActiveCreatorMember}
              styles={{ track: { flex: '0 0 1em' } }}
            />
            <InputSwitch
              name="meta.hideDownloads"
              label="Hide download count"
              disabled={!isActiveCreatorMember}
              styles={{ track: { flex: '0 0 1em' } }}
            />
            <InputSwitch
              name="meta.hideGenerations"
              label="Hide generation count"
              disabled={!isActiveCreatorMember}
              styles={{ track: { flex: '0 0 1em' } }}
            />
          </Stack>
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
          {(showClipSkip || showStrengthInput || showRecommendedResources) && (
            <Stack gap={4}>
              <Divider label="Recommended Settings" />
              <Group gap="xs" className="*:grow">
                {showClipSkip && (
                  <InputNumber
                    name="clipSkip"
                    label="Clip Skip"
                    placeholder="Clip Skip"
                    min={1}
                    max={12}
                  />
                )}
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
                {showRecommendedResources && (
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
          )}
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
        {children({ loading: upsertVersionMutation.isPending, canSave })}
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
  earlyAccessEndsAt: Date | null;
  earlyAccessConfig: ModelVersionEarlyAccessConfig | null;
};
type Props = {
  id?: string;
  onSubmit: (version?: ModelVersionUpsertInput) => void;
  children: (data: { loading: boolean; canSave: boolean }) => React.ReactNode;
  model?: Partial<ModelUpsertInput & { publishedAt: Date | null }>;
  // Base model of the model's most recent existing version; used to default the
  // picker when adding a brand-new version to an existing model.
  previousBaseModel?: string | null;
  // licensingFee comes off a Prisma read as a Decimal; the form coerces it to a number in defaultValues.
  version?: Omit<Partial<VersionInput>, 'licensingFee' | 'meta'> & {
    licensingFee?: number | { valueOf(): string } | null;
    flags?: number;
    meta?: unknown;
  };
  afterName?: React.ReactNode;
};
