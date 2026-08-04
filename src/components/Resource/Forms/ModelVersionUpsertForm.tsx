import {
  Alert,
  Anchor,
  Card,
  Checkbox,
  Divider,
  Group,
  Input,
  NumberInput,
  Popover,
  Radio,
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
import * as z from 'zod';

import { CapUpsell } from '~/components/Buzz/CapUpsell';
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
  InputCheckbox,
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
  ModelVersionMeta,
  ModelVersionPaidAccessDto,
  ModelVersionPaidAccessInputSchema,
  ModelVersionUpsertInput,
  RecommendedSettingsSchema,
} from '~/server/schema/model-version.schema';
import {
  baseModelToTraningDetailsBaseModelMap,
  modelVersionUpsertSchema2,
  recommendedSettingsSchema,
} from '~/server/schema/model-version.schema';
import {
  type ModelVersionTerms,
  DEFAULT_GENERATION_TRIAL_LIMIT,
  DEFAULT_FEE_IMAGES,
  MONETIZATION_RIGHTS_AFFIRMATION_STATEMENT,
  buildModelVersionTerms,
  feeMaxFor,
  hasCurrentRightsAffirmation,
  paidAccessCharges,
  feeToRatio,
  monetizationLimits,
  ratioToFee,
  resolveCapTier,
  suggestedFee,
} from '@civitai/buzz';
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

// The form keeps paid-access config — the timed early-access window AND the permanent gate — in this
// UX-shaped local field; the API contract is `paidAccess` + `donationGoal`. These transforms map across
// the boundary (submit / initial values).
const formPaidAccessConfigSchema = z.object({
  // Permanent = never-expiring gate (always paid); false = a timed Early Access window that becomes free.
  permanent: z.boolean().default(false),
  timeframe: z.number(),
  // "Price for access" — unlocks download + generation (the bundle). Required when charging.
  accessPrice: z.number().optional(),
  // Optional cheaper generation-only tier; defaults to the access price when unset.
  generationPrice: z.number().optional(),
  // Gate the download but leave generation free for everyone (no price, no trial limit).
  freeGeneration: z.boolean().default(false),
  // Free preview generations before purchase is required (the trial limit). Cleared/empty = 0 (no trial),
  // matching Creator Studio; a new gate seeds the default via the enable switch.
  freePreviewGenerations: z.preprocess(
    (v) => (v === '' || v == null || (typeof v === 'number' && Number.isNaN(v)) ? 0 : v),
    z.number().int()
  ),
  donationGoalEnabled: z.boolean().default(false),
  donationGoal: z.number().optional(),
});
type FormPaidAccessConfig = z.infer<typeof formPaidAccessConfigSchema>;

// Wrap the terms in the permanent/timed gate shape (or null for an off/invalid gate).
function toGate(
  config: FormPaidAccessConfig,
  terms: ModelVersionTerms
): ModelVersionPaidAccessInputSchema | null {
  if (config.permanent) return { permanent: true, terms };
  const timeframeDays = config.timeframe ?? 0;
  if (timeframeDays <= 0) return null;
  return { permanent: false, timeframeDays, terms };
}

function toPaidAccessInput(
  config: FormPaidAccessConfig | null | undefined,
  usageControl: ModelUsageControl | undefined
): ModelVersionPaidAccessInputSchema | null {
  if (!config || config.accessPrice == null) return null;
  // Only downloadable or on-site-generation versions can be gated; other usage controls (internal /
  // external API) can't set paid access at all.
  if (
    usageControl &&
    usageControl !== ModelUsageControl.Download &&
    usageControl !== ModelUsageControl.Generation
  )
    return null;
  const terms = buildModelVersionTerms({
    accessPrice: config.accessPrice,
    generationPrice: config.generationPrice,
    freePreviewGenerations: config.freePreviewGenerations,
    genOnly: usageControl === ModelUsageControl.Generation,
    freeGeneration: config.freeGeneration,
  });
  return toGate(config, terms);
}

type GenerationMode = 'bundled' | 'separate' | 'free';
const generationModeOf = (config: FormPaidAccessConfig | null | undefined): GenerationMode =>
  config?.freeGeneration ? 'free' : config?.generationPrice != null ? 'separate' : 'bundled';

function toDonationGoalInput(config: FormPaidAccessConfig | null | undefined) {
  // A donation goal only makes sense for a timed gate (it ends the window early); permanent never ends.
  if (config?.permanent || !config?.donationGoalEnabled || !config.donationGoal) return null;
  return { amount: config.donationGoal };
}

function toFormPaidAccessConfig(
  paidAccess: { timeframeDays: number | null; terms: ModelVersionTerms } | null | undefined,
  donationGoal: { goalAmount: number } | null | undefined
): FormPaidAccessConfig | null {
  if (!paidAccess) return null;
  const terms = paidAccess.terms ?? {};
  const paidGen = terms.generation && !('free' in terms.generation) ? terms.generation : undefined;
  return {
    // No timeframeDays on the row => a permanent (never-expiring) gate.
    permanent: paidAccess.timeframeDays == null,
    timeframe: paidAccess.timeframeDays ?? EARLY_ACCESS_CONFIG.timeframeValues[0],
    // "Price for access" is the download price when downloadable; for a gen-only version (no download
    // tier) it's the generation price. The separate generation-only tier only exists with a download bundle.
    accessPrice: terms.download?.price ?? paidGen?.price,
    generationPrice: terms.download ? paidGen?.price : undefined,
    freeGeneration: !!terms.generation && `free` in terms.generation,
    freePreviewGenerations: paidGen?.trialLimit ?? DEFAULT_GENERATION_TRIAL_LIMIT,
    donationGoalEnabled: !!donationGoal,
    donationGoal: donationGoal?.goalAmount,
  };
}

const schema = modelVersionUpsertSchema2
  .omit({ paidAccess: true, donationGoal: true })
  .extend({
    skipTrainedWords: z.boolean().default(false),
    paidAccessConfig: formPaidAccessConfigSchema
      // A timed gate needs a valid window; a permanent gate ignores the timeframe entirely.
      .refine(
        (c) => c.permanent || EARLY_ACCESS_CONFIG.timeframeValues.some((x) => x === c.timeframe),
        {
          error: 'Invalid value',
          path: ['timeframe'],
        }
      )
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
  // Pricing rules (paid access). A charging config must carry an access price (blank → silently ungated);
  // for a gen-only version this same price is the generation charge. The optional generation-only tier
  // can't cost more than the access price.
  .refine(
    (data) => {
      const c = data.paidAccessConfig;
      if (!c) return true;
      return c.accessPrice != null && c.accessPrice > 0;
    },
    { error: 'Enter a price for access', path: ['paidAccessConfig.accessPrice'] }
  )
  .refine(
    (data) => {
      const { generationPrice, accessPrice } = data.paidAccessConfig ?? {};
      if (generationPrice && accessPrice) return generationPrice <= accessPrice;
      return true;
    },
    {
      error: 'Generation-only price cannot be greater than the access price',
      path: ['paidAccessConfig.generationPrice'],
    }
  );
type Schema = z.infer<typeof schema>;

// Unfiltered on purpose: a legacy value must always be present in the options or
// the Select renders blank.
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
  // Retired field: only surfaced for legacy versions already carrying a non-default
  // value, so they stay editable/clearable without letting anyone newly opt in.
  // Read from the saved version, not form state, so picking 'Standard' doesn't rip
  // the control out mid-edit.
  const showBaseModelType = !!version?.baseModelType && version.baseModelType !== 'Standard';
  const showStrengthInput = ['LORA', 'Hypernetwork', 'LoCon', 'DoRA'].includes(model?.type ?? '');
  // "Over" means a TIMED window that has ended. A permanent gate (endsAt null) never ends, and a version
  // with no gate has nothing to be over — neither should lock the controls.
  const isEarlyAccessOver =
    version?.status === 'Published' &&
    !!version?.paidAccess?.endsAt &&
    !isFutureDate(version.paidAccess.endsAt);
  // A donation goal is immutable once it exists (create-once), and locked once the EA window is over.
  const donationGoalLocked = !!version?.donationGoal || isEarlyAccessOver;

  const MAX_EARLY_ACCCESS = 30;

  // A NEW version seeds the type-based suggested licensing fee (non-checkpoints = 1 ⚡ per 10 images), but only
  // when the fee editor is actually shown — never seed a fee the creator can't see. Existing versions keep their
  // stored value (0 = off).
  const initialLicensingFee = version?.id
    ? Number(version.licensingFee ?? 0)
    : features.licensingFee
    ? suggestedFee({ modelType: model?.type, baseModel: initialBaseModel })
    : 0;

  const defaultValues: Schema = {
    ...version,
    name: version?.name ?? 'v1.0',
    baseModel: initialBaseModel,
    baseModelType: version?.baseModelType ?? undefined,
    trainedWords: version?.trainedWords ?? [],
    skipTrainedWords: acceptsTrainedWords
      ? version?.trainedWords
        ? !version.trainedWords.length
        : false
      : true,
    paidAccessConfig: features.earlyAccessModel
      ? toFormPaidAccessConfig(version?.paidAccess, version?.donationGoal)
      : null,
    modelId: model?.id ?? -1,
    description: version?.description ?? null,
    epochs: version?.epochs ?? null,
    steps: version?.steps ?? null,
    clipSkip: version?.clipSkip ?? null,
    useMonetization: !!version?.monetization,
    monetization: version?.monetization ?? null,
    licensingFee: initialLicensingFee,
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
  const paidAccessConfig = form.watch('paidAccessConfig');
  // The three generation grants the terms model supports. Seeded from the stored config so an existing
  // choice survives an unrelated edit, and resynced in the form.reset effect below — without that, a reset
  // restores a price underneath a stale radio.
  const [genMode, setGenMode] = useState<GenerationMode>(() =>
    generationModeOf(toFormPaidAccessConfig(version?.paidAccess, version?.donationGoal))
  );
  const usageControl = form.watch('usageControl');
  const currentLicensingFee = form.watch('licensingFee') ?? 0;
  const existingSettlementCurrency = version?.licensingFeeSettlementCurrency ?? null;
  const hasExistingLicensingFee = Number(version?.licensingFee ?? 0) > 0;
  // The fee is edited as a whole-number "buzz per N images" ratio; the stored `licensingFee` stays per-image.
  const [feeRatio, setFeeRatio] = useState(() => feeToRatio(initialLicensingFee));
  const applyFeeRatio = (next: { buzz: number; images: number }) => {
    setFeeRatio(next);
    form.setValue('licensingFee', ratioToFee(next.buzz, next.images), {
      shouldDirty: true,
      shouldValidate: true,
    });
  };
  // Anyone may set a licensing fee, free tier included (CU 868kj4q49) — the tier caps only how much, and
  // checkpoints carry a higher ceiling than everything else. Moderators are uncapped. Mirrored server-side
  // in upsertModelVersionHandler, which is the enforcement point.
  //
  // `memberInBadState` mirrors the server's getCapTier, which excludes bad-state subs — so the UI never
  // advertises a ceiling the server will reject.
  const feeCapTier = resolveCapTier({
    tier: currentUser?.tier ?? null,
    isMember: !!currentUser?.tier && currentUser.tier !== 'free' && !currentUser.memberInBadState,
  });
  // Keyed to the WATCHED base model, not the seeded one, so switching ecosystem mid-form moves the caps
  // instead of stranding them on whatever the form loaded with.
  const limits = monetizationLimits({
    tier: feeCapTier,
    modelType: model?.type,
    baseModel,
    isModerator: currentUser?.isModerator,
    // Only a permanent gate has a price ceiling; a timed early-access window becomes free when it closes.
    permanent: !!paidAccessConfig?.permanent,
  });
  const licensingFeeCap = limits.fee.maxPerGeneration;
  const feeImageOptions = limits.fee.denominators;
  // An unlimited price renders as no cap at all, so the input falls back to the donation ceiling.
  const paidAccessCap = limits.access.maxPrice ?? MAX_DONATION_GOAL;
  const storedTerms = version?.paidAccess?.terms as ModelVersionTerms | undefined;
  const storedPaidGen =
    storedTerms?.generation && !('free' in storedTerms.generation)
      ? storedTerms.generation
      : undefined;
  // What the version already charges for access — the download bundle, or the generation price on a gen-only
  // version (which has no download tier, so `download?.price` alone would read as unpriced).
  const storedAccessPrice = storedTerms?.download?.price ?? storedPaidGen?.price ?? 0;
  const showLicensingFeeBlock =
    !isNonCommercial &&
    (!!features.licensingFee ||
      hasExistingLicensingFee ||
      existingSettlementCurrency === LicensingFeeSettlementCurrency.Cash);
  const showLicensingFeeSettlementCurrency =
    existingSettlementCurrency === LicensingFeeSettlementCurrency.Cash ||
    !!currentUser?.isModerator;

  // Asked once per version, the first time it earns anything — a version already on record keeps its
  // affirmation, so editing a price later doesn't ask again.
  //
  // Derived from the value the submit actually sends, not from the raw watched config: the config
  // survives (shouldUnregister: false) when its editor is hidden — a private model, or a usage control
  // that can't be gated — and reading it directly asked for an affirmation the server would never want.
  // The cast is the input-vs-output type of the form schema; both seed paths write concrete values.
  const gateCharges = paidAccessCharges(
    toPaidAccessInput(
      model?.availability === Availability.Private
        ? null
        : (paidAccessConfig as FormPaidAccessConfig | null | undefined),
      usageControl
    )
  );
  // No moderator carve-out here: this form has no way to tell a moderator editing someone else's model
  // from staff monetizing their own, and exempting on the role alone let every staff creator skip it.
  // The server applies the real ownership-scoped rule and simply ignores a moderator's tick on a model
  // they don't own.
  const requiresRightsAffirmation =
    !hasCurrentRightsAffirmation(version?.meta) && (currentLicensingFee > 0 || gateCharges);

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
    if ((form.getValues('licensingFee') ?? 0) > 0) {
      form.setValue('licensingFee', 0);
      setFeeRatio((r) => ({ buzz: 0, images: r.images }));
    }
    if (form.getValues('monetization')) form.setValue('monetization', null);
    if (form.getValues('paidAccessConfig')) form.setValue('paidAccessConfig', null);
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

    if (requiresRightsAffirmation && !data.rightsAffirmed) {
      const message = 'You must confirm you hold the rights to monetize this model';
      form.setError('rightsAffirmed', { message });
      // The checkbox can be well below the fold, and this also blocks wizard step navigation — an
      // inline-only error reads as the button doing nothing.
      showErrorNotification({ error: new Error(message), title: 'Confirmation required' });
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
      !isEqual(
        data.paidAccessConfig,
        toFormPaidAccessConfig(version?.paidAccess, version?.donationGoal)
      )
    ) {
      const recommendedResources =
        rawRecommendedResources?.map(({ id, strength }) => ({
          resourceId: id,
          settings: { strength },
        })) ?? [];

      const gatedConfig =
        model?.availability === Availability.Private ? null : data.paidAccessConfig;
      const result = await upsertVersionMutation.mutateAsync({
        ...data,
        // Don't persist a stale clip skip for base models that don't use it.
        clipSkip: showClipSkip ? data.clipSkip ?? null : null,
        epochs: data.epochs ?? null,
        steps: data.steps ?? null,
        modelId: model?.id ?? -1,
        paidAccess: toPaidAccessInput(gatedConfig, data.usageControl),
        donationGoal: toDonationGoalInput(gatedConfig),
        trainedWords: skipTrainedWords ? [] : trainedWords,
        baseModelType: data.baseModelType,
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
        paidAccessConfig: features.earlyAccessModel
          ? toFormPaidAccessConfig(version?.paidAccess, version?.donationGoal)
          : null,
        recommendedResources: version.recommendedResources ?? [],
        meta: {
          hideBuzz: (version.meta as ModelVersionMeta | null)?.hideBuzz ?? false,
          hideDownloads: (version.meta as ModelVersionMeta | null)?.hideDownloads ?? false,
          hideGenerations: (version.meta as ModelVersionMeta | null)?.hideGenerations ?? false,
        },
      });
      // Keep the ratio inputs in step with the form value reset (they're local state, not form-bound).
      setFeeRatio(feeToRatio(Number(version.licensingFee ?? 0)));
      // Same for the generation-price checkbox. Without this it keeps its mount-time value while `reset`
      // restores a generationPrice underneath it: on first render `version` is undefined so the box seeds
      // off, then a price arrives and is charged while the input stays hidden — and after the creator
      // unchecks it, any refetch/invalidate re-populates the value they just cleared and re-saves it.
      setGenMode(
        generationModeOf(toFormPaidAccessConfig(version.paidAccess, version.donationGoal))
      );
    }
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

  // A gate is present (timed OR permanent) — a permanent gate has no endsAt, so check the row, not endsAt.
  // Keeps the Paid Access section visible/editable for a published permanent-gated version.
  const atEarlyAccess = !!version?.paidAccess;
  const isPublished = version?.status === 'Published';
  // A gen-only version ratchets on its generation price, having no download tier. The stored price is a
  // floor: the server allows resubmitting over-cap, so clamping down would silently cut it.
  const accessPriceMax = Math.max(
    Math.min(
      isPublished ? storedAccessPrice || MAX_DONATION_GOAL : MAX_DONATION_GOAL,
      paidAccessCap
    ),
    storedAccessPrice
  );
  const isPrivateModel = model?.availability === Availability.Private;
  // A timed Early Access window can't be *started* after publish; only a version already on one keeps it.
  // Permanent Paid Access has no window, so it stays available post-publish.
  const timedAlreadySet = version?.paidAccess?.timeframeDays != null;
  const canChooseTimed = !isPublished || timedAlreadySet;
  // Paid access applies only to downloadable or on-site-generation versions (undefined = Download);
  // on-site-generation-only can't charge for download (see isGenOnly). Other controls can't be gated.
  const isGenOnly = usageControl === ModelUsageControl.Generation;
  const paidAccessUsageOk =
    !usageControl || usageControl === ModelUsageControl.Download || isGenOnly;
  // Who may configure a gate: a moderator; a creator with early-access score (timed EA, only pre-publish
  // or while already gated); or anyone adding permanent Paid Access post-publish (no timed window).
  const canConfigurePaidAccess =
    currentUser?.isModerator ||
    (maxEarlyAccessModels > 0 &&
      features.earlyAccessModel &&
      earlyAccessUnlockedDays.length > 0 &&
      (!isPublished || atEarlyAccess)) ||
    isPublished;
  const showPaidAccessInput =
    !model?.poi && // POI models won't allow EA.
    !isPrivateModel &&
    !isNonCommercial && // Non-commercial base models can't be monetized.
    paidAccessUsageOk &&
    canConfigurePaidAccess;
  const canIncreaseEarlyAccess = version?.status !== 'Published';
  const maxEarlyAccessValue = canIncreaseEarlyAccess
    ? MAX_EARLY_ACCCESS
    : version?.paidAccess?.timeframeDays ?? 0;

  // Editing a version that already holds an EA slot doesn't count against the cap — mirrors the
  // server carve-out in assertUserEarlyAccessLimits.
  const { data: userEarlyAccessVersions } = trpc.modelVersion.getUserEarlyAccessVersions.useQuery(
    undefined,
    { enabled: showPaidAccessInput && !currentUser?.isModerator }
  );
  const activeEarlyAccessCount = userEarlyAccessVersions?.length ?? 0;
  const editingCountsTowardCap =
    version?.id != null && !!userEarlyAccessVersions?.some((v) => v.id === version.id);
  const atEarlyAccessModelCap =
    !currentUser?.isModerator &&
    maxEarlyAccessModels > 0 &&
    activeEarlyAccessCount >= maxEarlyAccessModels &&
    !editingCountsTowardCap;
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
          <Card withBorder p="md">
            <Stack>
              <Text fw={600}>Version details</Text>
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
                      <Text>
                        People will be able to download & generate with this model version.
                      </Text>
                    ) : (
                      <Text>
                        People will be able to generate with this model version, but will{' '}
                        <span className="underline">not</span> be able to download it.
                      </Text>
                    )}
                  </Alert>
                </>
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
                {showBaseModelType && (
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
                    monetized (no licensing fees or paid early access) and commercial use is
                    disabled.
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
                  model-level controls — hiding at the model level already hides the model page
                  totals and cards.{' '}
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
                        This limits a bots ability to download the files associated with this
                        resource.
                        <br />
                        This will also require third-party applications to utilize a user API key to
                        download the asset files.
                      </>
                    }
                  />
                </Stack>
              )}
            </Stack>
          </Card>
          {(showPaidAccessInput || showLicensingFeeBlock || requiresRightsAffirmation) && (
            <Card withBorder p="md">
              <Stack gap={0}>
                <Text fw={600} mb="sm">
                  Monetization
                </Text>
                {showPaidAccessInput && (
                  <Stack gap={0}>
                    <Divider label="Paid Access Set Up" mb="md" />

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
                            Early access allows you to charge a fee for early access to your model.
                            Once the early access period ends, your model will be available to
                            everyone for free.
                          </Text>
                          {!currentUser?.isModerator && maxEarlyAccessModels > 0 && (
                            <Text size="xs">
                              You have {activeEarlyAccessCount} of {maxEarlyAccessModels} early
                              access {maxEarlyAccessModels === 1 ? 'slot' : 'slots'} in use. This
                              limit increases as you post more models on the site.
                            </Text>
                          )}
                        </Stack>
                      }
                      mb="xs"
                    />
                    {isEarlyAccessOver && (
                      <Text size="xs" c="red">
                        Early access has ended for this model version. You cannot make changes to
                        early access settings.
                      </Text>
                    )}
                    {atEarlyAccessModelCap && paidAccessConfig === null && (
                      <Alert color="yellow" icon={<IconAlertTriangle size={18} />} my="sm">
                        <Text size="xs">
                          You&apos;ve reached your limit of {maxEarlyAccessModels} concurrent early
                          access {maxEarlyAccessModels === 1 ? 'model' : 'models'}. Remove early
                          access from another model, or wait for one to end, before adding it here.
                        </Text>
                      </Alert>
                    )}
                    <Alert color="blue" icon={<IconInfoCircle size={18} />} my="sm">
                      <Text size="xs">
                        Charge a fee for access to this version — a timed{' '}
                        <Text span fw={600}>
                          Early Access
                        </Text>{' '}
                        window that becomes free when it ends, or ongoing{' '}
                        <Text span fw={600}>
                          Paid Access
                        </Text>{' '}
                        that always requires purchase. Buyers unlock download and generation.
                      </Text>
                    </Alert>
                    <Switch
                      my="sm"
                      label="I want to charge for access to this version"
                      checked={paidAccessConfig !== null}
                      onChange={(e) =>
                        form.setValue(
                          'paidAccessConfig',
                          e.target.checked
                            ? {
                                permanent: !canChooseTimed,
                                timeframe: EARLY_ACCESS_CONFIG.timeframeValues[0],
                                accessPrice: 5000,
                                generationPrice: undefined,
                                freePreviewGenerations: DEFAULT_GENERATION_TRIAL_LIMIT,
                                donationGoalEnabled: false,
                                donationGoal: undefined,
                              }
                            : null
                        )
                      }
                      disabled={
                        isEarlyAccessOver || (atEarlyAccessModelCap && paidAccessConfig === null)
                      }
                    />
                    {paidAccessConfig && (
                      <Stack>
                        <Input.Wrapper
                          label={<Text fw="bold">Access mode</Text>}
                          description={
                            paidAccessConfig.permanent
                              ? 'Always requires purchase — this version never becomes free.'
                              : 'A timed Early Access window; the version becomes free when it ends.'
                          }
                        >
                          <SegmentedControl
                            value={paidAccessConfig.permanent ? 'permanent' : 'timed'}
                            onChange={(value) =>
                              form.setValue('paidAccessConfig.permanent', value === 'permanent')
                            }
                            data={[
                              {
                                label: 'Early Access (timed)',
                                value: 'timed',
                                // A timed window can't be started after publish (permanent stays available).
                                disabled: !canChooseTimed,
                              },
                              {
                                label: 'Paid Access (permanent)',
                                value: 'permanent',
                              },
                            ]}
                            color="blue"
                            size="xs"
                            fullWidth
                            disabled={isEarlyAccessOver}
                            styles={{
                              root: {
                                border: `1px solid ${
                                  colorScheme === 'dark'
                                    ? theme.colors.dark[4]
                                    : theme.colors.gray[4]
                                }`,
                                background: 'none',
                                marginTop: 'calc(var(--mantine-spacing-xs) * 0.5)',
                              },
                            }}
                          />
                        </Input.Wrapper>
                        {!paidAccessConfig.permanent && (
                          <Input.Wrapper
                            label={
                              <Group gap="xs">
                                <Text fw="bold">Early access time frame</Text>
                                <Popover width={300} withArrow withinPortal shadow="sm">
                                  <Popover.Target>
                                    <IconInfoCircle size={16} />
                                  </Popover.Target>
                                  <Popover.Dropdown>
                                    <Stack gap="xs">
                                      <Text size="sm">
                                        The amount of resources you can have in early access and for
                                        how long is determined by actions you&rsquo;ve taken on the
                                        site. Increase your limits by posting more free models that
                                        people want, being kind, and generally doing good within the
                                        community.
                                      </Text>
                                    </Stack>
                                  </Popover.Dropdown>
                                </Popover>
                              </Group>
                            }
                            description="When the window ends the version becomes free. Up to 30 days at your current Creator Program score."
                            error={form.formState.errors.paidAccessConfig?.message}
                          >
                            <SegmentedControl
                              onChange={(value) =>
                                form.setValue('paidAccessConfig.timeframe', parseInt(value, 10))
                              }
                              value={
                                paidAccessConfig?.timeframe?.toString() ??
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
                                    colorScheme === 'dark'
                                      ? theme.colors.dark[4]
                                      : theme.colors.gray[4]
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
                                  You will unlock more early access day over time by posting models
                                  to the site.
                                </Text>
                              </Group>
                            )}
                            {!canIncreaseEarlyAccess && (
                              <Text size="xs" c="dimmed" mt="sm">
                                You cannot increase early access value after a model has been
                                published
                              </Text>
                            )}
                          </Input.Wrapper>
                        )}
                        <Stack mt="sm">
                          <Card withBorder>
                            <Card.Section withBorder inheritPadding py="sm">
                              <Text fw={600} size="sm">
                                Pricing
                              </Text>
                            </Card.Section>
                            <Card.Section inheritPadding py="sm">
                              <Stack>
                                <InputNumber
                                  name="paidAccessConfig.accessPrice"
                                  label="Price for access"
                                  description={
                                    isGenOnly
                                      ? 'What buyers pay to generate with this version on-site.'
                                      : 'Buyers unlock download + generation.'
                                  }
                                  min={100}
                                  max={accessPriceMax}
                                  step={100}
                                  leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                                  withAsterisk
                                  disabled={isEarlyAccessOver}
                                />
                                {(paidAccessConfig?.accessPrice ?? 0) > paidAccessCap && (
                                  <Text size="xs" c="yellow.5">
                                    This price is above your membership&apos;s{' '}
                                    {paidAccessCap.toLocaleString()} Buzz cap. You can keep or lower
                                    it, but not raise it.
                                  </Text>
                                )}
                                {!currentUser?.isModerator && (
                                  <CapUpsell
                                    value={paidAccessConfig?.accessPrice}
                                    cap={limits.access.maxPrice ?? Infinity}
                                    capTier={feeCapTier}
                                    capFor={(t) =>
                                      monetizationLimits({ tier: t, baseModel, permanent: true })
                                        .access.maxPrice ?? Infinity
                                    }
                                    title="Price for access"
                                  />
                                )}
                                {!isGenOnly && (
                                  <>
                                    <Radio.Group
                                      label="Generating on-site"
                                      value={genMode}
                                      onChange={(next) => {
                                        const mode = next as GenerationMode;
                                        setGenMode(mode);
                                        // Only `separate` carries a price — the other two must clear it, or a
                                        // stale value would keep the cheaper tier alive underneath the choice.
                                        if (mode !== 'separate')
                                          form.setValue(
                                            'paidAccessConfig.generationPrice',
                                            undefined as never
                                          );
                                        form.setValue(
                                          'paidAccessConfig.freeGeneration',
                                          mode === 'free'
                                        );
                                      }}
                                    >
                                      <Stack gap={4} mt={4}>
                                        <Radio
                                          value="bundled"
                                          label="Same as the access price"
                                          disabled={isEarlyAccessOver}
                                        />
                                        <Radio
                                          value="separate"
                                          label="A cheaper generation-only price"
                                          disabled={isEarlyAccessOver}
                                        />
                                        <Radio
                                          value="free"
                                          label="Free for everyone"
                                          description="Anyone can generate on-site without buying; only the download is gated. Earn per generation with a licensing fee instead."
                                          disabled={isEarlyAccessOver}
                                        />
                                      </Stack>
                                    </Radio.Group>
                                    {genMode === 'separate' && (
                                      <InputNumber
                                        name="paidAccessConfig.generationPrice"
                                        label="Generation-only price"
                                        description="What buyers pay to generate on-site without unlocking the download. Can't exceed the access price."
                                        min={50}
                                        // Grandfather floor, as on the access price — generation is capped
                                        // per-component and increase-only.
                                        max={Math.max(
                                          Math.min(
                                            paidAccessConfig?.accessPrice ?? paidAccessCap,
                                            paidAccessCap
                                          ),
                                          storedPaidGen?.price ?? 0
                                        )}
                                        step={100}
                                        leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                                        disabled={isEarlyAccessOver}
                                      />
                                    )}
                                  </>
                                )}
                                {/* A free grant has no trial to run out, so there's nothing to sample toward. */}
                                {!(genMode === 'free' && !isGenOnly) && (
                                  <InputNumber
                                    name="paidAccessConfig.freePreviewGenerations"
                                    label="Free preview generations"
                                    description={`How many free test generations a user can do before purchasing the ${resourceLabel}.`}
                                    min={0}
                                    max={1000}
                                    disabled={isEarlyAccessOver}
                                    withAsterisk
                                  />
                                )}
                              </Stack>
                            </Card.Section>
                          </Card>

                          {!paidAccessConfig.permanent &&
                            (version?.status !== 'Published' || version?.donationGoal) &&
                            features.donationGoals && (
                              <Card withBorder>
                                <Card.Section withBorder>
                                  <Group py="sm" px="md" justify="space-between" wrap="nowrap">
                                    <div>
                                      <Text fw={500} size="sm">
                                        Let the community unlock this early
                                      </Text>
                                      <Text size="xs">
                                        If the goal is met before the window ends, early access ends
                                        immediately and the version becomes free for everyone. After
                                        the model is published, you cannot change this value.
                                      </Text>
                                    </div>
                                    <InputSwitch
                                      name="paidAccessConfig.donationGoalEnabled"
                                      disabled={donationGoalLocked}
                                      onChange={(e) => {
                                        if (e.target.checked) {
                                          form.setValue('paidAccessConfig.donationGoal', 50000);
                                        } else {
                                          form.setValue('paidAccessConfig.donationGoal', undefined);
                                        }
                                      }}
                                    />
                                  </Group>
                                </Card.Section>
                                {paidAccessConfig?.donationGoalEnabled && (
                                  <Card.Section py="sm" px="md">
                                    <Stack>
                                      <InputNumber
                                        name="paidAccessConfig.donationGoal"
                                        label="Goal amount"
                                        description="Early access purchases count toward this goal. After publishing, you cannot change this value."
                                        min={MIN_DONATION_GOAL}
                                        max={MAX_DONATION_GOAL}
                                        step={100}
                                        leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                                        disabled={donationGoalLocked}
                                      />
                                      <Switch
                                        label="Hide donation goals from public view"
                                        description="Others won't see the progress bar or collected amount. The goal still works, and you and moderators can still see it. This applies to all of your donation goals."
                                        checked={hideDonationGoals ?? false}
                                        onChange={(e) =>
                                          mutateUserSettings({
                                            hideDonationGoals: e.target.checked,
                                          })
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

                    {version?.paidAccess && !paidAccessConfig && (
                      <Text size="xs" c="red">
                        You will not be able to add this model to early access again after removing
                        it. Also, your payment for early access will be lost. Please consider this
                        before removing early access.
                      </Text>
                    )}
                    {(showLicensingFeeBlock || requiresRightsAffirmation) && <Divider my="md" />}
                  </Stack>
                )}
                {showLicensingFeeBlock && (
                  <Stack gap="xs">
                    <Input.Wrapper
                      label="License Fee"
                      description={`Charge for generations using this version, as Buzz per number of generations. If this is a derivative of a base model that already charges a licensing fee, your fee is added on top of it. Set 0 to disable. Your membership allows up to ${licensingFeeCap} Buzz per generation for this model type.`}
                    >
                      <Group gap="xs" wrap="nowrap" mt={4}>
                        <NumberInput
                          aria-label="Licensing fee (Buzz)"
                          value={feeRatio.buzz}
                          onChange={(v) =>
                            applyFeeRatio({
                              buzz: typeof v === 'number' ? v : 0,
                              images: feeRatio.images,
                            })
                          }
                          min={0}
                          max={feeMaxFor(limits, feeRatio.images)}
                          step={1}
                          allowDecimal={false}
                          leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                          w={140}
                        />
                        <Text size="sm" c="dimmed">
                          per
                        </Text>
                        <Select
                          aria-label="Number of generations"
                          value={String(feeRatio.images)}
                          onChange={(v) => {
                            const images = Number(v) || DEFAULT_FEE_IMAGES;
                            // Clamp in the RATIO domain: the cap is per-image and can be fractional (free/other is
                            // 0.1), so `cap * images` would put a decimal into a whole-number field the schema then
                            // rejects. floor() keeps the value enterable and valid.
                            applyFeeRatio({
                              buzz: Math.min(feeRatio.buzz, feeMaxFor(limits, images)),
                              images,
                            });
                          }}
                          data={feeImageOptions.map((n) => ({
                            value: String(n),
                            label: String(n),
                          }))}
                          allowDeselect={false}
                          w={90}
                        />
                        <Text size="sm" c="dimmed">
                          {feeRatio.images === 1 ? 'generation' : 'generations'}
                        </Text>
                      </Group>
                    </Input.Wrapper>
                    {!currentUser?.isModerator && (
                      <CapUpsell
                        value={feeRatio.buzz}
                        cap={feeMaxFor(limits, feeRatio.images)}
                        capTier={feeCapTier}
                        capFor={(t) =>
                          feeMaxFor(
                            monetizationLimits({ tier: t, modelType: model?.type, baseModel }),
                            feeRatio.images
                          )
                        }
                        title="Licensing fee"
                        perLabel={`${feeRatio.images} generation${
                          feeRatio.images === 1 ? '' : 's'
                        }`}
                      />
                    )}
                    {currentLicensingFee > licensingFeeCap && (
                      <Text size="xs" c="yellow.5">
                        This fee is above your membership&apos;s {licensingFeeCap} Buzz cap for this
                        model type. You can keep or lower it, but not raise it.
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
                          With a license fee set, this version stops earning creator compensation
                          and tips — you earn through the license fee instead.
                        </Text>
                      </Group>
                    )}
                    {requiresRightsAffirmation && <Divider my="md" />}
                  </Stack>
                )}
                {requiresRightsAffirmation && (
                  <InputCheckbox
                    name="rightsAffirmed"
                    label={MONETIZATION_RIGHTS_AFFIRMATION_STATEMENT}
                  />
                )}
              </Stack>
            </Card>
          )}
        </Stack>
        {children({ loading: upsertVersionMutation.isPending, canSave })}
      </Form>
    </>
  );
}

type VersionInput = Omit<
  ModelVersionUpsertInput,
  'recommendedResources' | 'paidAccess' | 'donationGoal'
> & {
  createdAt: Date | null;
  recommendedResources?: (Omit<
    GenerationResourceSchema,
    'strength' | 'minStrength' | 'maxStrength'
  > &
    RecommendedSettingsSchema)[];
  // The DTO shape the version is loaded with (getById), NOT the write-input shape.
  paidAccess: ModelVersionPaidAccessDto | null;
  donationGoal: { goalAmount: number } | null;
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
