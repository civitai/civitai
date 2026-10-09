import {
  ActionIcon,
  Button,
  Grid,
  Group,
  Input,
  NumberInput,
  Paper,
  SimpleGrid,
  Slider,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  IconArrowBackUp,
  IconArrowLeft,
  IconCalendar,
  IconCheck,
  IconClock,
  IconInfoCircle,
  IconLock,
  IconPencil,
  IconPhoto,
  IconPlus,
  IconTicket,
  IconTrash,
  IconTrophy,
  IconVideo,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { BackButton } from '~/components/BackButton/BackButton';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { CrucibleCard } from '~/components/Cards/CrucibleCard';
import { ContentRatingSelect } from '~/components/Challenge/ContentRatingSelect';
import { ModelVersionMultiSelect } from '~/components/Challenge/ModelVersionMultiSelect';
import { CrucibleContentLevelBadges } from '~/components/Crucible/CrucibleContentLevelBadges';
import { CrucibleImageUpload } from '~/components/Crucible/CrucibleImageUpload';
import {
  CRUCIBLE_CREATE_STEP_COUNT,
  crucibleCreateFormSchema,
  crucibleToFormValues,
  entryFeeRangeLabel,
  getCrucibleCostBreakdown,
  getCrucibleEditableFields,
  getCrucibleUpdateChanges,
  getMaxCrucibleSeed,
  getPlaceBuzz,
  getPrizePlaceColor,
  getPrizePlaceLimit,
  restrictContentLevelsToBuzzType,
  type CrucibleBuzzType,
  type CrucibleCreateFormValues,
  type CrucibleUpdateChanges,
  type PlaceBuzz,
} from '~/components/Crucible/crucible-create-form';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  Form,
  InputDateTimePicker,
  InputMultiSelect,
  InputNumber,
  InputSelect,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { withController } from '~/libs/form/hoc/withController';
import { useIsClient } from '~/providers/IsClientProvider';
import { NsfwLevel } from '~/server/common/enums';
import {
  exceedsModelBrowsingLevelLimit,
  matureBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  CRUCIBLE_DEFAULT_PRIZE_POSITIONS,
  CRUCIBLE_DESCRIPTION_MAX_LENGTH,
  CRUCIBLE_DURATION_COSTS,
  CRUCIBLE_MAX_ALLOWED_BASE_MODELS,
  CRUCIBLE_MAX_CLIP_SECONDS_OPTIONS,
  CRUCIBLE_MAX_ENTRIES,
  CRUCIBLE_ENTRY_CUTOFF_PERCENT,
  CRUCIBLE_ENTRY_WARNING_PERCENT,
  CRUCIBLE_ENTRY_WINDOW_ORDER_MESSAGE,
  CRUCIBLE_MAX_ENTRY_FEE,
  CRUCIBLE_MAX_SEEDED_PRIZE_POOL,
  CRUCIBLE_MAX_TOTAL_ENTRIES,
  CRUCIBLE_MIN_ENTRY_FEE,
  CRUCIBLE_MIN_TOTAL_ENTRIES,
  CRUCIBLE_MIN_VIEW_SECONDS_OPTIONS,
  CRUCIBLE_NAME_MAX_LENGTH,
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
  CRUCIBLE_RESOURCE_REQUIREMENTS_COST,
  getMaxCrucibleStartAt,
  getPrizeDistributionTotal,
  hasCrucibleStarted,
  isCustomPrizeDistribution,
  type CrucibleContentType,
} from '~/shared/constants/crucible.constants';
import { baseModelSelectData } from '~/shared/constants/basemodel.constants';
import {
  CHALLENGE_CREATE_DAILY_LIMIT,
  describeActiveLimitsByTier,
} from '~/shared/constants/challenge.constants';
import { getBuzzCurrencyConfig } from '~/shared/constants/currency.constants';
import { Flags } from '~/shared/utils/flags';
import { CrucibleStatus, Currency, MediaType } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';
import {
  baseModelMakesMediaType,
  CRUCIBLE_PRIZE_BUZZ_TYPE,
  getCrucibleUrl,
  getFreeEntriesLabel,
  toCrucibleBuzzType,
} from '~/utils/crucible-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { capitalize } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const InputContentRatingSelect = withController(ContentRatingSelect);

const getCrucibleBaseModelSelectData = (contentType: CrucibleContentType) =>
  baseModelSelectData.flatMap(({ items }) =>
    items.filter(({ value }) => baseModelMakesMediaType(value, contentType))
  );
const InputModelVersionMultiSelect = withController(ModelVersionMultiSelect);
const InputCrucibleImage = withController(CrucibleImageUpload);

const durationOptions = [
  { value: 24, label: '24 hours' },
  { value: 72, label: '3 days' },
  { value: 168, label: '7 days' },
].map((option) => ({ ...option, cost: CRUCIBLE_DURATION_COSTS[option.value] ?? 0 }));

const getDurationLabel = (hours: number) =>
  durationOptions.find((d) => d.value === hours)?.label ?? `${hours} hours`;

type ContentTypeOption = { value: CrucibleContentType; label: string; Icon: typeof IconPhoto };

const contentTypeOptions: ContentTypeOption[] = [
  { value: MediaType.image, label: 'Images', Icon: IconPhoto },
  { value: MediaType.video, label: 'Videos', Icon: IconVideo },
];

const formatSeconds = (seconds: number) =>
  seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;

const NO_RULE = 0;
const toVideoRule = (seconds: number | undefined) => seconds || undefined;

// The abbreviation follows DST (PDT vs PST), so read it at the date being shown.
const getLocalTimeZoneName = (at: Date) =>
  new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value;

const toTotalEntriesCap = (maxTotalEntries: number | undefined) => maxTotalEntries || undefined;

const countLabel = (count: number, singular: string, plural: string) =>
  `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
/** A share of a run in hours, e.g. 10% of 24h is "2.4h". */
const hoursOf = (durationHours: number, percent: number) =>
  `${Number(((durationHours * percent) / 100).toFixed(1))}h`;
const entriesLabel = (count: number) => countLabel(count, 'entry', 'entries');
const placesLabel = (count: number) => countLabel(count, 'place', 'places');

const stepFields: Record<number, (keyof CrucibleCreateFormValues)[]> = {
  1: ['name', 'description', 'duration', 'startAt', 'nsfwLevel'],
  2: [
    'contentType',
    'entryFee',
    'entryLimit',
    'freeEntriesPerUser',
    'maxTotalEntries',
    'entryWarningPercent',
    'entryCutoffPercent',
    'minViewSeconds',
    'maxClipSeconds',
  ],
  3: ['seededPrizePool'],
};

const stepLabels = ['Basic Info', 'Entry Rules', 'Prizes', 'Review'];

export function useCrucibleWizardForm(defaultValues: CrucibleCreateFormValues) {
  // The wizard unmounts each step's inputs, so they must keep their values when unregistered.
  return useForm({ schema: crucibleCreateFormSchema, defaultValues, shouldUnregister: false });
}
export type CrucibleWizardForm = ReturnType<typeof useCrucibleWizardForm>;

export type CrucibleEditTarget = NonNullable<RouterOutput['crucible']['getById']>;

type Props = { form: CrucibleWizardForm; loading: boolean } & (
  | { crucible?: undefined; onSubmit: (values: CrucibleCreateFormValues) => void }
  | { crucible: CrucibleEditTarget; onSubmit: (changes: CrucibleUpdateChanges) => void }
);

export function CrucibleUpsertWizard(props: Props) {
  const { form, crucible, loading } = props;
  const currentUser = useCurrentUser();
  const isClient = useIsClient();
  const wizardTopRef = useRef<HTMLDivElement>(null);
  const [prizeEditMode, setPrizeEditMode] = useState(false);
  const [initialValues] = useState(() => (crucible ? crucibleToFormValues(crucible) : undefined));
  const values = form.watch();

  const [domainBuzzType] = useAvailableBuzz();
  // What the creator pays setup and seed in. An edit settles in the currency first paid, which a
  // moderator may be editing from the other site.
  const buzzType = toCrucibleBuzzType(crucible ? crucible.buzzType : domainBuzzType);

  const isModerator = !!currentUser?.isModerator;
  const hasStarted = !!crucible && hasCrucibleStarted(crucible);
  const canEditAll = !crucible || (crucible.userId === currentUser?.id && !hasStarted);
  const rulesLocked = !canEditAll;
  const canEditContentLevels = canEditAll || (isModerator && !hasStarted);
  const editableFields = getCrucibleEditableFields({ canEditAll, canEditContentLevels });

  useEffect(() => {
    if (!canEditContentLevels) return;
    const allowed = restrictContentLevelsToBuzzType(buzzType, values.nsfwLevel);
    if (allowed !== values.nsfwLevel) form.setValue('nsfwLevel', allowed);
  }, [buzzType, values.nsfwLevel, canEditContentLevels]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server's zone isn't the viewer's, so the name is only read on the client.
  const timeZoneName = isClient ? getLocalTimeZoneName(values.startAt ?? new Date()) : undefined;
  const localTimeNote = `Times are in your local time${timeZoneName ? ` (${timeZoneName})` : ''}.`;
  const startNowLabel = crucible ? 'as soon as you save' : 'as soon as you create it';

  const prizeCustomized = isCustomPrizeDistribution(values.prizePositions);

  const setPrizePositions = (prizePositions: Record<string, number>) =>
    form.setValue('prizePositions', prizePositions);

  const isStep1Valid = () => values.name.trim().length > 0 && !!values.coverImage;

  // Mirrors the server's `checkCrucibleSettings`.
  const minViewSeconds = toVideoRule(values.minViewSeconds);
  const maxClipSeconds = toVideoRule(values.maxClipSeconds);
  const videoSettingsError =
    minViewSeconds != null && maxClipSeconds != null && minViewSeconds > maxClipSeconds
      ? 'Minimum view time cannot exceed the maximum clip length'
      : null;

  const totalEntriesCap = toTotalEntriesCap(values.maxTotalEntries);
  const entryLimitError =
    totalEntriesCap != null && values.entryLimit > totalEntriesCap
      ? 'Entries per user cannot exceed the maximum total entries'
      : null;
  const freeEntriesPerUser = values.freeEntriesPerUser ?? 0;
  const freeEntriesError =
    freeEntriesPerUser > values.entryLimit
      ? 'Free entries cannot exceed the entry limit per user'
      : null;
  const entryWindowError =
    values.entryCutoffPercent >= values.entryWarningPercent
      ? CRUCIBLE_ENTRY_WINDOW_ORDER_MESSAGE
      : null;
  const freeEntriesLabel = getFreeEntriesLabel({
    freeEntriesPerUser,
    entryLimit: values.entryLimit,
  });

  const requiredVersionIds = values.allowedResources ?? [];
  // Mirrors the server's `assertRequiredModelsAllowContentLevel`, which stops checking once the
  // level and models are locked.
  const allowsMatureContent =
    canEditContentLevels && Flags.intersects(values.nsfwLevel, matureBrowsingLevelsFlag);
  const { data: requiredVersions } = trpc.modelVersion.getVersionsByIds.useQuery(
    { ids: requiredVersionIds },
    { enabled: allowsMatureContent && requiredVersionIds.length > 0 }
  );
  const heldToSfwModels = allowsMatureContent
    ? (requiredVersions ?? [])
        .filter(
          (version) =>
            requiredVersionIds.includes(version.id) &&
            exceedsModelBrowsingLevelLimit(values.nsfwLevel, version)
        )
        .map((version) => version.modelName)
    : [];
  const contentLevelError = heldToSfwModels.length
    ? `${[...new Set(heldToSfwModels)].join(
        ', '
      )} can only be required for PG and PG-13 content. Allow only PG and PG-13, or remove ${
        heldToSfwModels.length === 1 ? 'it' : 'them'
      }.`
    : null;

  const isStep2Valid = () =>
    !contentLevelError &&
    (rulesLocked ||
      (values.entryFee != null &&
        values.entryFee >= CRUCIBLE_MIN_ENTRY_FEE &&
        values.entryFee <= CRUCIBLE_MAX_ENTRY_FEE &&
        values.entryLimit >= 1 &&
        values.entryLimit <= CRUCIBLE_MAX_ENTRIES &&
        !entryLimitError &&
        !freeEntriesError &&
        !entryWindowError &&
        !videoSettingsError));

  const totalPrizePercentage = getPrizeDistributionTotal(values.prizePositions);
  const prizeDistributionError =
    totalPrizePercentage === 100
      ? null
      : totalPrizePercentage > 100
      ? `Prize percentages add up to ${totalPrizePercentage}%. Lower them to exactly 100%.`
      : `Prize percentages add up to ${totalPrizePercentage}%. Assign the remaining ${
          100 - totalPrizePercentage
        }% so they total exactly 100%.`;

  const placeCount = Object.keys(values.prizePositions).length;
  const placeLimit = getPrizePlaceLimit(totalEntriesCap);
  const prizePlacesError =
    placeCount > placeLimit
      ? `A crucible capped at ${entriesLabel(placeLimit)} can pay at most ${placesLabel(
          placeLimit
        )}. Remove ${placesLabel(placeCount - placeLimit)}.`
      : null;
  const prizeSplitError = prizeDistributionError ?? prizePlacesError;

  const {
    data: { accounts: buzzAccounts },
  } = useQueryBuzz([buzzType]);
  const buzzBalance = buzzAccounts.find((account) => account.type === buzzType)?.balance;
  const maxSeed =
    buzzBalance === undefined
      ? CRUCIBLE_MAX_SEEDED_PRIZE_POOL
      : getMaxCrucibleSeed({ balance: buzzBalance, paidSeed: initialValues?.seededPrizePool });
  const seedError =
    !rulesLocked && buzzBalance !== undefined && (values.seededPrizePool ?? 0) > maxSeed
      ? `You have ${Math.max(
          0,
          buzzBalance
        ).toLocaleString()} ${buzzType} Buzz, so the seed can be at most ${maxSeed.toLocaleString()}.`
      : null;

  const isStep3Valid = () =>
    rulesLocked ||
    (values.seededPrizePool != null && !prizeDistributionError && !prizePlacesError && !seedError);

  // Clamped so a restored draft can't open past a step it no longer passes.
  const currentStep = Math.min(
    values.step,
    !isStep1Valid() ? 1 : !isStep2Valid() ? 2 : !isStep3Valid() ? 3 : CRUCIBLE_CREATE_STEP_COUNT
  );
  const allStepsValid = isStep1Valid() && isStep2Valid() && isStep3Valid();
  const [uploadingImages, setUploadingImages] = useState<Record<string, boolean>>({});
  const imagesUploading = Object.values(uploadingImages).some(Boolean);
  const setUploadingImage = (field: string, uploading: boolean) =>
    setUploadingImages((current) => ({ ...current, [field]: uploading }));

  const setStep = (step: number) => {
    // A step unmounts its upload inputs, which would drop an image still uploading.
    if (imagesUploading) return;
    form.setValue('step', step);
    wizardTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const cost = getCrucibleCostBreakdown(values);
  const paidCost = initialValues ? getCrucibleCostBreakdown(initialValues).total : 0;
  const costDifference = initialValues ? cost.total - paidCost : cost.total;

  const changes = initialValues
    ? getCrucibleUpdateChanges({ initial: initialValues, values, editableFields })
    : undefined;
  const hasChanges = !!changes && Object.keys(changes).length > 0;

  const placeBuzz = getPlaceBuzz({
    prizePositions: values.prizePositions,
    seededPrizePool: values.seededPrizePool ?? 0,
    entryFee: values.entryFee ?? 0,
    maxTotalEntries: totalEntriesCap,
    freeEntriesPerUser,
  });
  const prizePoolNote = (
    <>
      <Text size="xs" c="dimmed" mt="xs">
        {freeEntriesPerUser > 0
          ? 'The prize pool is your seed plus every paid entry fee; free entries add nothing.'
          : 'The prize pool is your seed plus every entry fee, so what each place wins grows with the number of entries.'}
        {freeEntriesPerUser > 0 &&
          !values.seededPrizePool &&
          ' With no seed, winners only share what paid entries bring in.'}
      </Text>
      <Text size="xs" c="dimmed" mt={4}>
        Each creator can win at most one prize. A creator who places more than once is paid for
        their best entry, and the next creator moves up.
      </Text>
    </>
  );

  const canAddPrizePosition = placeCount < placeLimit;
  const addPrizePosition = () => {
    if (!canAddPrizePosition) return;
    setPrizePositions({ ...values.prizePositions, [(placeCount + 1).toString()]: 0 });
  };

  const removePrizePosition = (position: string) => {
    const remaining = { ...values.prizePositions };
    delete remaining[position];
    const renumbered: Record<string, number> = {};
    Object.entries(remaining)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .forEach(([, value], index) => {
        renumbered[(index + 1).toString()] = value;
      });
    setPrizePositions(renumbered);
  };

  const resetPrizeDistribution = () => {
    setPrizePositions({ ...CRUCIBLE_DEFAULT_PRIZE_POSITIONS });
    setPrizeEditMode(false);
  };

  const handleNext = async () => {
    const fields = stepFields[currentStep]?.filter((field) =>
      (editableFields as readonly string[]).includes(field)
    );
    if (fields?.length && !(await form.trigger(fields))) return;
    if (currentStep === 1 && !isStep1Valid()) return;
    if (currentStep === 2 && !isStep2Valid()) return;
    if (currentStep === 3 && !isStep3Valid()) return;
    setStep(currentStep + 1);
  };

  const handleSubmit = async () => {
    if (loading) return;
    // A locked field is never sent, so a stored value the form would now reject can't block a save.
    const valid = await form.trigger(crucible ? [...editableFields] : undefined);
    if (!valid || !allStepsValid) return;
    const submitted = form.getValues();
    if (props.crucible === undefined) props.onSubmit(submitted);
    else if (initialValues)
      props.onSubmit(
        getCrucibleUpdateChanges({ initial: initialValues, values: submitted, editableFields })
      );
  };

  const lockedNote = rulesLocked && (
    <Group gap={6} wrap="nowrap" align="flex-start">
      <IconLock size={14} className="mt-0.5 shrink-0 text-gray-5" />
      <Text size="xs" c="dimmed">
        {hasStarted
          ? "These settings can't change once the crucible has started, so the outcome stays fair."
          : 'Only the creator can change these settings.'}
      </Text>
    </Group>
  );

  const renderStep1 = () => (
    <Stack gap="xl">
      {!crucible && (
        <Text size="sm" c="dimmed">
          {`How many crucibles you can have running or scheduled at once depends on membership (${describeActiveLimitsByTier()}). Anyone can create at most ${CHALLENGE_CREATE_DAILY_LIMIT} in any 24 hours.`}
        </Text>
      )}
      <InputCrucibleImage
        name="coverImage"
        label="Cover Image"
        description="This image appears on discovery cards, which are portrait, so a tall image works best (about 7:9, e.g. 1400×1800)"
        dropzoneLabel="Drag & drop cover image here or click to browse"
        onUploadingChange={(uploading) => setUploadingImage('coverImage', uploading)}
        withAsterisk
      />

      <InputCrucibleImage
        name="heroImage"
        label="Banner Image"
        description="Optional. Shown across the top of the crucible's page, so a wide image works best (about 3:1, e.g. 1920×640). The cover image is used when this is empty."
        dropzoneLabel="Drag & drop a banner image here or click to browse"
        onUploadingChange={(uploading) => setUploadingImage('heroImage', uploading)}
      />

      <InputText
        name="name"
        label="Crucible Name"
        description={`Maximum ${CRUCIBLE_NAME_MAX_LENGTH} characters`}
        placeholder="e.g., Anime Character Design Challenge"
        maxLength={CRUCIBLE_NAME_MAX_LENGTH}
        withAsterisk
      />

      <InputTextArea
        name="description"
        label="Description"
        description={`Describe the theme, rules, or inspiration. Maximum ${CRUCIBLE_DESCRIPTION_MAX_LENGTH} characters. (Optional)`}
        placeholder="e.g., Design an original anime character set in a neon-lit cyberpunk city. Show the full outfit, and keep it an original character — no fan art of existing ones."
        maxLength={CRUCIBLE_DESCRIPTION_MAX_LENGTH}
        autosize
        minRows={3}
      />

      {lockedNote}

      <Input.Wrapper
        label="Duration"
        description="Duration determines how long the crucible accepts entries"
        withAsterisk
      >
        <SimpleGrid cols={durationOptions.length} mt={8}>
          {durationOptions.map((option) => (
            <Paper
              key={option.value}
              className={`border p-3 text-center transition-all ${
                values.duration === option.value
                  ? 'border-blue-500 bg-blue-500/20'
                  : 'border-dark-4 hover:border-blue-500'
              } ${rulesLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
              onClick={rulesLocked ? undefined : () => form.setValue('duration', option.value)}
            >
              <Text size="sm" fw={500}>
                {option.label}
              </Text>
              <div className="mt-1">
                {option.cost === 0 ? (
                  <Text size="xs" c="green" fw={700}>
                    FREE
                  </Text>
                ) : (
                  <BuzzAmount amount={option.cost} buzzType={buzzType} size="xs" prefix="+" />
                )}
              </div>
            </Paper>
          ))}
        </SimpleGrid>
      </Input.Wrapper>

      <InputDateTimePicker
        name="startAt"
        label="Start Date"
        description={`Leave empty to start the crucible ${startNowLabel}. ${localTimeNote}`}
        placeholder="Start immediately"
        valueFormat="lll"
        minDate={new Date()}
        maxDate={getMaxCrucibleStartAt()}
        disabled={rulesLocked}
        clearable
      />

      <InputContentRatingSelect
        name="nsfwLevel"
        label="Allowed Content Levels"
        description={
          buzzType === 'green'
            ? 'Users can only submit content matching these levels. Crucibles created on civitai.com are SFW only.'
            : 'Users can only submit content matching these levels'
        }
        sfwOnly={buzzType === 'green'}
        disabled={!canEditContentLevels}
        error={contentLevelError}
      />
    </Stack>
  );

  const renderStep2 = () => (
    <Stack gap="xl">
      {lockedNote}

      <Input.Wrapper
        label="Content Type"
        description="What entrants submit and judges compare"
        withAsterisk
      >
        <SimpleGrid cols={2} mt={8}>
          {contentTypeOptions.map(({ value, label, Icon }) => (
            <Paper
              key={value}
              className={`border p-3 transition-all ${
                values.contentType === value
                  ? 'border-blue-500 bg-blue-500/20'
                  : 'border-dark-4 hover:border-blue-500'
              } ${rulesLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
              onClick={
                rulesLocked
                  ? undefined
                  : () => {
                      form.setValue('contentType', value);
                      form.setValue(
                        'allowedBaseModels',
                        (form.getValues('allowedBaseModels') ?? []).filter((baseModel) =>
                          baseModelMakesMediaType(baseModel, value)
                        )
                      );
                      if (value !== MediaType.video) {
                        form.setValue('minViewSeconds', undefined);
                        form.setValue('maxClipSeconds', undefined);
                      }
                    }
              }
            >
              <Group gap={6} justify="center">
                <Icon size={16} />
                <Text size="sm" fw={500}>
                  {label}
                </Text>
              </Group>
            </Paper>
          ))}
        </SimpleGrid>
      </Input.Wrapper>

      <InputNumber
        name="entryFee"
        label="Entry Fee per User"
        description={`How much Buzz users pay to enter their ${
          values.contentType === MediaType.video ? 'video' : 'image'
        } (${entryFeeRangeLabel}). Entrants pay in green Buzz on civitai.com and yellow on civitai.red; prizes are paid in yellow.`}
        leftSection={<CurrencyIcon currency={Currency.BUZZ} type={buzzType} size={16} />}
        min={CRUCIBLE_MIN_ENTRY_FEE}
        max={CRUCIBLE_MAX_ENTRY_FEE}
        clampToMax
        step={10}
        allowNegative={false}
        allowDecimal={false}
        clampBehavior="blur"
        disabled={rulesLocked}
        withAsterisk
      />

      <InputNumber
        name="entryLimit"
        label="Entry Limit per User"
        description={`How many times can one user enter? (1–${CRUCIBLE_MAX_ENTRIES})`}
        min={1}
        max={CRUCIBLE_MAX_ENTRIES}
        clampToMax
        allowNegative={false}
        allowDecimal={false}
        clampBehavior="blur"
        error={entryLimitError}
        disabled={rulesLocked}
        withAsterisk
      />

      <InputNumber
        name="freeEntriesPerUser"
        label="Free Entries per User"
        description="Each user's first entries skip the fee and add nothing to the prize pool."
        min={0}
        max={values.entryLimit}
        clampToMax
        allowNegative={false}
        allowDecimal={false}
        clampBehavior="blur"
        error={freeEntriesError}
        disabled={rulesLocked}
      />

      <div>
        <InputNumber
          name="maxTotalEntries"
          label="Maximum Total Entries"
          description={`Optional cap on entries across all users (${CRUCIBLE_MIN_TOTAL_ENTRIES}–${CRUCIBLE_MAX_TOTAL_ENTRIES.toLocaleString()}). Leave empty or enter 0 for no limit.`}
          placeholder="No limit"
          min={0}
          max={CRUCIBLE_MAX_TOTAL_ENTRIES}
          clampToMax
          allowNegative={false}
          allowDecimal={false}
          clampBehavior="blur"
          disabled={rulesLocked}
          clearable
          // Step errors are only re-checked on Next, so a corrected value would keep the old one.
          onChange={() => form.clearErrors('maxTotalEntries')}
        />
        {!rulesLocked && prizePlacesError && (
          <Text size="xs" c="red" mt={4}>
            {prizePlacesError} You can do that on the Prizes step.
          </Text>
        )}
        <Group gap={6} mt={8} align="flex-start" wrap="nowrap">
          <IconInfoCircle size={14} className="mt-0.5 shrink-0 text-blue-5" />
          <Text size="xs" c="dimmed">
            If nobody enters, your seed is refunded. If there are fewer entries than paid places,
            the unfilled places&apos; share is split among the winners in proportion to their
            shares, so a single entry takes the whole pool.
          </Text>
        </Group>
      </div>

      <Input.Wrapper
        label="Late Entries"
        description={`A late entry has less time to be judged and may not get enough votes to place. Shares are of the crucible's ${values.duration}h run, counted back from the end.`}
      >
        <Stack gap="md" mt={8}>
          <InputNumber
            name="entryWarningPercent"
            label="Warn entrants"
            description={`Entrants are warned their entry may not place in the last ${hoursOf(
              values.duration,
              values.entryWarningPercent
            )} (${CRUCIBLE_ENTRY_WARNING_PERCENT.min}–${CRUCIBLE_ENTRY_WARNING_PERCENT.max}%)`}
            suffix="%"
            min={CRUCIBLE_ENTRY_WARNING_PERCENT.min}
            max={CRUCIBLE_ENTRY_WARNING_PERCENT.max}
            clampToMax
            allowNegative={false}
            allowDecimal={false}
            clampBehavior="blur"
            disabled={rulesLocked}
          />
          <InputNumber
            name="entryCutoffPercent"
            label="Close entries"
            description={
              values.entryCutoffPercent
                ? `No new entries in the last ${hoursOf(
                    values.duration,
                    values.entryCutoffPercent
                  )} (0–${CRUCIBLE_ENTRY_CUTOFF_PERCENT.max}%)`
                : `0% takes entries until the very end (0–${CRUCIBLE_ENTRY_CUTOFF_PERCENT.max}%)`
            }
            suffix="%"
            min={CRUCIBLE_ENTRY_CUTOFF_PERCENT.min}
            max={CRUCIBLE_ENTRY_CUTOFF_PERCENT.max}
            clampToMax
            allowNegative={false}
            allowDecimal={false}
            clampBehavior="blur"
            error={entryWindowError}
            disabled={rulesLocked}
          />
        </Stack>
      </Input.Wrapper>

      {values.contentType === MediaType.video && (
        <Input.Wrapper
          label="Advanced Video Options"
          description="Optional. Both default to no rule."
        >
          <Stack gap="md" mt={8}>
            <InputSelect
              name="minViewSeconds"
              label="Minimum view time"
              description="Judges must watch this much of BOTH clips before either vote unlocks"
              placeholder="No minimum"
              data={[
                { value: NO_RULE, label: 'No minimum' },
                ...CRUCIBLE_MIN_VIEW_SECONDS_OPTIONS.map((seconds) => ({
                  value: seconds,
                  label: formatSeconds(seconds),
                  disabled: maxClipSeconds != null && seconds > maxClipSeconds,
                })),
              ]}
              allowDeselect={false}
              disabled={rulesLocked}
            />
            <InputSelect
              name="maxClipSeconds"
              label="Maximum clip length"
              description="Entries longer than this are rejected on submission"
              placeholder="No maximum"
              data={[
                { value: NO_RULE, label: 'No maximum' },
                ...CRUCIBLE_MAX_CLIP_SECONDS_OPTIONS.map((seconds) => ({
                  value: seconds,
                  label: formatSeconds(seconds),
                  disabled: minViewSeconds != null && seconds < minViewSeconds,
                })),
              ]}
              allowDeselect={false}
              disabled={rulesLocked}
            />
            {videoSettingsError && (
              <Text size="xs" c="red">
                {videoSettingsError}
              </Text>
            )}
          </Stack>
        </Input.Wrapper>
      )}

      <InputModelVersionMultiSelect
        name="allowedResources"
        label={
          <Group gap={8} component="span">
            Resource Requirements
            <CostTag amount={CRUCIBLE_RESOURCE_REQUIREMENTS_COST} buzzType={buzzType} />
          </Group>
        }
        description="Entries must use at least one of the selected models. Leave empty to allow any model."
        disabled={rulesLocked}
        generatableOnly={false}
        mediaType={values.contentType}
        error={contentLevelError}
      />

      <InputMultiSelect
        name="allowedBaseModels"
        label="Base Model Requirements"
        description="Entries must be made with a checkpoint of one of these base models. Leave empty to allow any base model."
        placeholder="Any base model"
        data={getCrucibleBaseModelSelectData(values.contentType)}
        maxValues={CRUCIBLE_MAX_ALLOWED_BASE_MODELS}
        searchable
        clearable
        disabled={rulesLocked}
      />
    </Stack>
  );

  const renderStep3 = () => {
    const sortedPositions = Object.entries(values.prizePositions).sort(
      ([a], [b]) => parseInt(a) - parseInt(b)
    );

    const seededPoolInput = (
      <InputNumber
        name="seededPrizePool"
        label="Seed the Prize Pool"
        description={`${
          crucible
            ? 'Add your own Buzz on top of what entry fees collect. A change is charged or refunded when you save.'
            : 'Add your own Buzz on top of what entry fees collect. Charged when you create the crucible.'
        } Up to ${maxSeed.toLocaleString()} Buzz.`}
        leftSection={<CurrencyIcon currency={Currency.BUZZ} type={buzzType} size={16} />}
        min={0}
        max={maxSeed}
        clampToMax
        error={seedError}
        step={100}
        allowNegative={false}
        allowDecimal={false}
        clampBehavior="blur"
        disabled={rulesLocked}
      />
    );

    if (!prizeEditMode || rulesLocked) {
      return (
        <Stack gap="lg">
          {lockedNote}
          {seededPoolInput}

          <div>
            <Text size="xs" c="dimmed" fw={600} mb={8}>
              {prizeCustomized ? 'Custom Distribution' : 'Default Distribution'}
            </Text>
            <PrizeDistributionChart prizePositions={values.prizePositions} placeBuzz={placeBuzz} />
            {prizePoolNote}
          </div>

          {!rulesLocked && (
            <>
              {prizeSplitError && (
                <Text size="sm" c="red">
                  {prizeSplitError}
                </Text>
              )}

              <Group gap="md">
                {prizeCustomized && (
                  <Button
                    variant="light"
                    color="gray"
                    onClick={resetPrizeDistribution}
                    leftSection={<IconArrowBackUp size={16} />}
                    style={{ flex: 1 }}
                  >
                    Reset to Default
                  </Button>
                )}
                <Button
                  variant="filled"
                  color="blue"
                  onClick={() => setPrizeEditMode(true)}
                  leftSection={<IconPencil size={16} />}
                  rightSection={
                    !prizeCustomized && (
                      <CostTag amount={CRUCIBLE_PRIZE_CUSTOMIZATION_COST} buzzType={buzzType} />
                    )
                  }
                  style={{ flex: 1 }}
                >
                  {prizeCustomized ? 'Edit Distribution' : 'Customize Distribution'}
                </Button>
              </Group>
            </>
          )}
        </Stack>
      );
    }

    return (
      <Stack gap="lg">
        {seededPoolInput}

        <Group gap="xs">
          <IconPencil size={16} className="text-blue-5" />
          <Text size="sm" c="blue" fw={600}>
            Editing Prize Distribution
          </Text>
        </Group>

        {sortedPositions.map(([position, percentage], index) => {
          const color = getPrizePlaceColor(index);
          const place = parseInt(position);
          return (
            <Paper
              key={position}
              p="md"
              className="border border-l-4 border-dark-4"
              style={{ borderLeftColor: `var(--mantine-color-${color}-6)` }}
            >
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <div className="min-w-0">
                  <Text size="sm" fw={600}>
                    {formatPlace(position)}
                  </Text>
                  <PlaceBuzzText amount={placeBuzz[position]} buzzType={CRUCIBLE_PRIZE_BUZZ_TYPE} />
                </div>
                <Group gap="xs" wrap="nowrap">
                  <NumberInput
                    aria-label={`${formatPlace(position)} share`}
                    value={percentage}
                    onChange={(value) =>
                      setPrizePositions({
                        ...values.prizePositions,
                        [position]: typeof value === 'number' ? value : 0,
                      })
                    }
                    min={0}
                    max={100}
                    isAllowed={({ floatValue }) => {
                      if ((floatValue ?? 0) <= 100) return true;
                      setPrizePositions({ ...values.prizePositions, [position]: 100 });
                      return false;
                    }}
                    allowNegative={false}
                    allowDecimal={false}
                    clampBehavior="strict"
                    suffix="%"
                    hideControls
                    w={80}
                  />
                  {(place > 3 || place > placeLimit) && (
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="sm"
                      aria-label={`Remove ${formatPlace(position)}`}
                      onClick={() => removePrizePosition(position)}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  )}
                </Group>
              </Group>
              <Slider
                mt="md"
                value={percentage}
                onChange={(value) =>
                  setPrizePositions({ ...values.prizePositions, [position]: value })
                }
                min={0}
                max={100}
                step={1}
                color={color}
                styles={{
                  track: { height: 6 },
                  thumb: { borderWidth: 2 },
                }}
              />
            </Paper>
          );
        })}

        {prizePoolNote}

        <div>
          <Button
            variant="light"
            color="blue"
            onClick={addPrizePosition}
            disabled={!canAddPrizePosition}
            leftSection={<IconPlus size={16} />}
            fullWidth
          >
            Add Prize Position
          </Button>
          {!canAddPrizePosition && placeLimit === totalEntriesCap && (
            <Text size="xs" c="dimmed" mt={4}>
              With at most {entriesLabel(placeLimit)}, no more places can be paid.
            </Text>
          )}
        </div>

        <Paper p="md" className="border border-dark-4" bg="dark.7">
          <Group justify="space-between">
            <Text c="dimmed">Total Distribution</Text>
            <Text size="lg" fw={700} c={prizeDistributionError ? 'red' : 'green'}>
              {totalPrizePercentage}%
            </Text>
          </Group>
          {prizeSplitError && (
            <Text size="xs" c="red" mt={4}>
              {prizeSplitError}
            </Text>
          )}
        </Paper>

        <Group gap="md">
          {prizeCustomized && (
            <Button
              variant="light"
              color="gray"
              onClick={resetPrizeDistribution}
              leftSection={<IconArrowBackUp size={16} />}
              style={{ flex: 1 }}
            >
              Reset to Default
            </Button>
          )}
          <Button
            variant="filled"
            color="blue"
            onClick={() => setPrizeEditMode(false)}
            disabled={!!prizeSplitError}
            leftSection={<IconCheck size={16} />}
            style={{ flex: 1 }}
          >
            Done Editing
          </Button>
        </Group>
      </Stack>
    );
  };

  const renderStep4 = () => (
    <Stack gap="xl">
      <Title order={3}>{crucible ? 'Review Your Changes' : 'Review Your Crucible'}</Title>

      {!hasStarted && (
        <EstimatedSchedule
          durationHours={values.duration}
          startAt={values.startAt}
          localTimeNote={localTimeNote}
          startNowLabel={startNowLabel}
        />
      )}

      {initialValues && costDifference !== 0 && (
        <Paper p="lg" className="border border-dark-4">
          <Group justify="space-between">
            <Text fw={600}>Cost change</Text>
            <CostDifferenceText difference={costDifference} buzzType={buzzType} />
          </Group>
        </Paper>
      )}

      <Paper p="lg" className="border border-dark-4">
        <Group gap="xs" mb="md">
          <IconInfoCircle size={20} className="text-blue-5" />
          <Text fw={600}>Basic Information</Text>
        </Group>
        <Stack gap="sm">
          <Group justify="space-between">
            <Text c="dimmed">Name</Text>
            <Text fw={500}>{values.name || 'Not set'}</Text>
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">Duration</Text>
            <Text fw={500}>{getDurationLabel(values.duration)}</Text>
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">Description</Text>
            <Text fw={500} lineClamp={2} style={{ maxWidth: 300, textAlign: 'right' }}>
              {values.description || 'None'}
            </Text>
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">Banner Image</Text>
            <Text fw={500}>{values.heroImage ? 'Custom' : 'Cover image'}</Text>
          </Group>
        </Stack>
      </Paper>

      <Paper p="lg" className="border border-dark-4">
        <Group gap="xs" mb="md">
          <IconTicket size={20} className="text-blue-5" />
          <Text fw={600}>Entry Settings</Text>
        </Group>
        <Stack gap="sm">
          <Group justify="space-between">
            <Text c="dimmed">Content Type</Text>
            <Text fw={500}>
              {contentTypeOptions.find((o) => o.value === values.contentType)?.label}
            </Text>
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">Content Levels</Text>
            <CrucibleContentLevelBadges nsfwLevel={values.nsfwLevel} className="justify-end" />
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">Entry Fee</Text>
            <CurrencyBadge
              unitAmount={values.entryFee ?? 0}
              currency={Currency.BUZZ}
              type={buzzType}
            />
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">Entry Limit per User</Text>
            <Text fw={500}>
              {values.entryLimit} {values.entryLimit === 1 ? 'entry' : 'entries'}
            </Text>
          </Group>
          {freeEntriesLabel && (
            <Group justify="space-between">
              <Text c="dimmed">Free Entries</Text>
              <Text fw={500}>{freeEntriesLabel}</Text>
            </Group>
          )}
          <Group justify="space-between">
            <Text c="dimmed">Max Total Entries</Text>
            <Text fw={500}>
              {values.maxTotalEntries ? numberWithCommas(values.maxTotalEntries) : 'Unlimited'}
            </Text>
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">Entries Close</Text>
            <Text fw={500}>
              {values.entryCutoffPercent
                ? `Last ${hoursOf(values.duration, values.entryCutoffPercent)} (${
                    values.entryCutoffPercent
                  }%)`
                : 'At the end'}
            </Text>
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">Required Resources</Text>
            <Text fw={500}>
              {values.allowedResources?.length
                ? `${values.allowedResources.length} ${
                    values.allowedResources.length === 1 ? 'model' : 'models'
                  }`
                : 'Any model'}
            </Text>
          </Group>
          <Group justify="space-between" wrap="nowrap">
            <Text c="dimmed">Base Models</Text>
            <Text fw={500} ta="right">
              {values.allowedBaseModels?.length
                ? values.allowedBaseModels.join(', ')
                : 'Any base model'}
            </Text>
          </Group>
          {values.contentType === MediaType.video && (
            <>
              <Group justify="space-between">
                <Text c="dimmed">Minimum View Time</Text>
                <Text fw={500}>{minViewSeconds ? formatSeconds(minViewSeconds) : 'None'}</Text>
              </Group>
              <Group justify="space-between">
                <Text c="dimmed">Maximum Clip Length</Text>
                <Text fw={500}>{maxClipSeconds ? formatSeconds(maxClipSeconds) : 'Unlimited'}</Text>
              </Group>
            </>
          )}
        </Stack>
      </Paper>

      <Paper p="lg" className="border border-dark-4">
        <Group gap="xs" mb="md">
          <IconTrophy size={20} className="text-blue-5" />
          <Text fw={600}>Prize Distribution</Text>
        </Group>
        <Stack gap="md">
          <Group justify="space-between">
            <Text c="dimmed">Seeded Prize Pool</Text>
            {values.seededPrizePool > 0 ? (
              <CurrencyBadge
                unitAmount={values.seededPrizePool}
                currency={Currency.BUZZ}
                type={buzzType}
              />
            ) : (
              <Text fw={500}>None</Text>
            )}
          </Group>
          <PrizeDistributionChart prizePositions={values.prizePositions} placeBuzz={placeBuzz} />
        </Stack>
      </Paper>
    </Stack>
  );

  const renderCurrentStep = () => {
    switch (currentStep) {
      case 2:
        return renderStep2();
      case 3:
        return renderStep3();
      case 4:
        return renderStep4();
      default:
        return renderStep1();
    }
  };

  const previewCover = values.coverImage;
  const startMs = values.startAt?.getTime() ?? Date.now();
  const previewCard = {
    id: crucible?.id ?? 0,
    name: values.name.trim() || 'Your Crucible Name',
    status:
      crucible?.status ?? (startMs > Date.now() ? CrucibleStatus.Pending : CrucibleStatus.Active),
    nsfwLevel: values.nsfwLevel,
    startAt: hasStarted ? crucible?.startAt ?? null : new Date(startMs),
    endAt: hasStarted
      ? crucible?.endAt ?? null
      : new Date(startMs + values.duration * 60 * 60 * 1000),
    entryFee: values.entryFee ?? 0,
    seededPrizePool: values.seededPrizePool ?? 0,
    buzzType,
    user: crucible?.user ?? {
      id: currentUser?.id ?? 0,
      username: currentUser?.username ?? null,
      deletedAt: null,
      image: currentUser?.image ?? null,
    },
    image:
      crucible?.image && previewCover?.url === crucible.image.url
        ? crucible.image
        : previewCover
        ? {
            id: 0,
            url: previewCover.url,
            type: MediaType.image,
            name: null,
            metadata: null,
            nsfwLevel: NsfwLevel.PG,
            width: previewCover.width,
            height: previewCover.height,
          }
        : null,
    _count: { entries: crucible?._count.entries ?? 0 },
    paidEntryCount: crucible?.paidEntryCount ?? 0,
  };

  const submitLabel = crucible ? 'Save Changes' : 'Create Crucible';
  const showSubmit = crucible ? true : currentStep === CRUCIBLE_CREATE_STEP_COUNT;
  const submitDisabled = !allStepsValid || (!!crucible && !hasChanges) || imagesUploading;

  return (
    <Form form={form}>
      <Grid gutter="xl">
        <Grid.Col span={{ base: 12, lg: 8 }}>
          <Group gap="md" mb="xl" wrap="nowrap">
            <BackButton
              url={crucible ? getCrucibleUrl(crucible.id, crucible.name) : '/crucibles'}
            />
            <div className="min-w-0">
              <Title order={2}>{crucible ? 'Edit Crucible' : 'Create Crucible'}</Title>
              <Text c="dimmed" size="sm" lineClamp={1}>
                {crucible ? crucible.name : 'Set up a new creative competition'}
              </Text>
            </div>
          </Group>

          <Group ref={wizardTopRef} gap="xs" mb="xl" className="scroll-mt-20">
            {stepLabels.map((label, index) => (
              <Paper
                key={label}
                className={`flex-1 cursor-pointer border p-2 text-center ${
                  currentStep === index + 1
                    ? 'border-blue-500 bg-blue-500/20'
                    : currentStep > index + 1
                    ? 'border-green-500 bg-green-500/10'
                    : 'border-dark-4'
                }`}
                onClick={() => {
                  if (index + 1 < currentStep) setStep(index + 1);
                }}
              >
                <Text size="xs" c="dimmed">
                  Step {index + 1}
                </Text>
                <Text size="sm" fw={500}>
                  {label}
                </Text>
              </Paper>
            ))}
          </Group>

          <Paper p="xl" className="border border-dark-4">
            <Group gap="sm" mb="lg" pb="md" className="border-b border-dark-4">
              <div className="flex size-8 items-center justify-center rounded-lg bg-blue-500/10">
                {currentStep === 2 ? (
                  <IconTicket size={18} className="text-blue-5" />
                ) : currentStep === 3 ? (
                  <IconTrophy size={18} className="text-blue-5" />
                ) : (
                  <IconInfoCircle size={18} className="text-blue-5" />
                )}
              </div>
              <Text fw={600}>{stepLabels[currentStep - 1]}</Text>
            </Group>

            {renderCurrentStep()}
          </Paper>

          <Group justify="space-between" mt="xl">
            <Button
              variant="light"
              color="gray"
              onClick={() => setStep(currentStep - 1)}
              disabled={currentStep === 1 || imagesUploading}
              leftSection={<IconArrowLeft size={16} />}
            >
              Previous
            </Button>
            {currentStep < CRUCIBLE_CREATE_STEP_COUNT && (
              <Button
                onClick={handleNext}
                disabled={
                  imagesUploading ||
                  (currentStep === 1 && !isStep1Valid()) ||
                  (currentStep === 2 && !isStep2Valid()) ||
                  (currentStep === 3 && !isStep3Valid())
                }
              >
                Next
              </Button>
            )}
          </Group>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 4 }}>
          <div className="sticky top-8">
            <Text size="xs" c="dimmed" fw={600} mb="sm" tt="uppercase">
              Preview
            </Text>
            <div
              // React 18 has no `inert` prop.
              ref={(node) => node?.setAttribute('inert', '')}
              className="mx-auto mb-4 w-full max-w-[260px]"
            >
              <CrucibleCard data={previewCard} />
            </div>

            {showSubmit &&
              (costDifference > 0 ? (
                <BuzzTransactionButton
                  fullWidth
                  size="lg"
                  mb="md"
                  buzzAmount={costDifference}
                  exactAccountTypes={[buzzType]}
                  label={submitLabel}
                  loading={loading}
                  disabled={submitDisabled}
                  onPerformTransaction={handleSubmit}
                  showPurchaseModal
                />
              ) : (
                <Button
                  fullWidth
                  size="lg"
                  mb="md"
                  loading={loading}
                  disabled={submitDisabled}
                  onClick={handleSubmit}
                >
                  {submitLabel}
                </Button>
              ))}

            {!(crucible && rulesLocked) && (
              <Paper p="md" className="border border-dark-4">
                <Text size="xs" c="dimmed" fw={600} mb="md" tt="uppercase">
                  Cost Breakdown
                </Text>
                <Stack gap="xs">
                  <CostRow label="Duration" amount={cost.duration} buzzType={buzzType} />
                  <CostRow label="Entry Limit" amount={0} buzzType={buzzType} />
                  <CostRow
                    label="Prize Customization"
                    amount={cost.prizeCustomization}
                    buzzType={buzzType}
                  />
                  <CostRow
                    label="Resource Requirements"
                    amount={cost.resourceRequirements}
                    buzzType={buzzType}
                  />
                  <CostRow
                    label="Seeded Prize Pool"
                    amount={cost.seed}
                    buzzType={buzzType}
                    zeroLabel="None"
                  />
                  <div className="mt-2 border-t border-dark-4 pt-3">
                    <Group justify="space-between">
                      <Text size="sm" fw={600}>
                        Total Cost
                      </Text>
                      {cost.total === 0 ? (
                        <Text size="md" fw={700}>
                          Free
                        </Text>
                      ) : (
                        <BuzzAmount amount={cost.total} buzzType={buzzType} size="md" />
                      )}
                    </Group>
                    {initialValues && (
                      <>
                        <Group justify="space-between" mt="xs">
                          <Text size="sm" c="dimmed">
                            Already paid
                          </Text>
                          <BuzzAmount amount={paidCost} buzzType={buzzType} size="sm" />
                        </Group>
                        <Group justify="flex-end" mt="xs">
                          <CostDifferenceText difference={costDifference} buzzType={buzzType} />
                        </Group>
                      </>
                    )}
                  </div>
                </Stack>
              </Paper>
            )}
          </div>
        </Grid.Col>
      </Grid>
    </Form>
  );
}

function BuzzAmount({
  amount,
  buzzType,
  size = 'sm',
  prefix = '',
}: {
  amount: number;
  buzzType: CrucibleBuzzType;
  size?: 'xs' | 'sm' | 'md';
  prefix?: string;
}) {
  const iconSize = { xs: 12, sm: 14, md: 16 }[size];
  return (
    <Group gap={4} wrap="nowrap" justify="center">
      <CurrencyIcon currency={Currency.BUZZ} type={buzzType} size={iconSize} />
      <Text size={size} fw={700} style={{ color: getBuzzCurrencyConfig(buzzType).color }}>
        {prefix}
        {amount.toLocaleString()}
      </Text>
    </Group>
  );
}

function CostTag({ amount, buzzType }: { amount: number; buzzType: CrucibleBuzzType }) {
  return (
    <CurrencyBadge
      currency={Currency.BUZZ}
      type={buzzType}
      unitAmount={amount}
      formatter={(value) => `+${value.toLocaleString()}`}
      size="xs"
    />
  );
}

function CostDifferenceText({
  difference,
  buzzType,
}: {
  difference: number;
  buzzType: CrucibleBuzzType;
}) {
  if (difference === 0)
    return (
      <Text size="sm" c="dimmed">
        No change in cost
      </Text>
    );

  const amount = <BuzzAmount amount={Math.abs(difference)} buzzType={buzzType} />;
  return difference > 0 ? (
    <Group gap={4} wrap="nowrap">
      <Text size="sm">You&apos;ll be charged</Text>
      {amount}
      <Text size="sm">more</Text>
    </Group>
  ) : (
    <Group gap={4} wrap="nowrap">
      {amount}
      <Text size="sm">will be refunded</Text>
    </Group>
  );
}

function PlaceBuzzText({ amount, buzzType }: { amount?: PlaceBuzz; buzzType: CrucibleBuzzType }) {
  const parts = [
    amount?.fromSeed != null && { value: amount.fromSeed, label: 'from your seed' },
    amount?.whenFull != null && {
      value: amount.whenFull,
      label: 'if full',
      prefix: amount.whenFullIsCeiling ? 'up to ' : '',
    },
  ].filter((part): part is { value: number; label: string; prefix?: string } => !!part);
  if (!parts.length) return null;

  return (
    <Group gap={8} wrap="wrap">
      {parts.map((part) => (
        <Group key={part.label} gap={2} wrap="nowrap">
          <CurrencyIcon currency={Currency.BUZZ} type={buzzType} size={12} />
          <Text size="xs" c="dimmed">
            {part.prefix}
            {part.value.toLocaleString()} {part.label}
          </Text>
        </Group>
      ))}
    </Group>
  );
}

function PrizeDistributionChart({
  prizePositions,
  placeBuzz,
}: {
  prizePositions: Record<string, number>;
  placeBuzz: Record<string, PlaceBuzz>;
}) {
  const sortedPositions = Object.entries(prizePositions).sort(
    ([a], [b]) => parseInt(a) - parseInt(b)
  );

  return (
    <Stack gap="md">
      <div className="flex h-8 overflow-hidden rounded border border-dark-4">
        {sortedPositions.map(([position, percentage], index) => {
          const color = getPrizePlaceColor(index);
          return (
            <div
              key={position}
              className="flex items-center justify-center text-xs font-bold text-white"
              style={{
                flex: percentage || 0.1,
                background: `linear-gradient(to right, var(--mantine-color-${color}-6), var(--mantine-color-${color}-7))`,
              }}
            >
              {percentage > 10 && `${formatPlace(position, false)}: ${percentage}%`}
            </div>
          );
        })}
      </div>

      <SimpleGrid cols={{ base: 2, sm: 3 }}>
        {sortedPositions.slice(0, 3).map(([position, percentage], index) => (
          <Paper
            key={position}
            p="md"
            className="border border-t-4 border-dark-4 text-center"
            style={{ borderTopColor: `var(--mantine-color-${getPrizePlaceColor(index)}-6)` }}
            bg="dark.7"
          >
            <Text size="xs" c="dimmed" mb={6}>
              {formatPlace(position)}
            </Text>
            <Text size="xl" fw={700} c={`${getPrizePlaceColor(index)}.4`}>
              {percentage}%
            </Text>
            <Group justify="center">
              <PlaceBuzzText amount={placeBuzz[position]} buzzType={CRUCIBLE_PRIZE_BUZZ_TYPE} />
            </Group>
          </Paper>
        ))}
      </SimpleGrid>

      {sortedPositions.length > 3 && (
        <Paper p="md" className="border border-dark-4">
          <Stack gap="xs">
            {sortedPositions.slice(3).map(([position, percentage], index) => {
              const color = getPrizePlaceColor(index + 3);
              return (
                <Group key={position} justify="space-between" wrap="nowrap">
                  <Group gap="xs" wrap="nowrap">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: `var(--mantine-color-${color}-6)` }}
                    />
                    <div>
                      <Text size="sm" c="dimmed">
                        {formatPlace(position)}
                      </Text>
                      <PlaceBuzzText
                        amount={placeBuzz[position]}
                        buzzType={CRUCIBLE_PRIZE_BUZZ_TYPE}
                      />
                    </div>
                  </Group>
                  <Text size="sm" fw={600} c={`${color}.4`}>
                    {percentage}%
                  </Text>
                </Group>
              );
            })}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}

const formatDateTime = (date: Date) =>
  date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

function EstimatedSchedule({
  durationHours,
  startAt,
  localTimeNote,
  startNowLabel,
}: {
  durationHours: number;
  startAt?: Date | null;
  localTimeNote: string;
  startNowLabel: string;
}) {
  // An immediate start is "now" at submit time, so both estimates have to follow the clock while
  // the creator sits on this step.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const scheduledStart = startAt && startAt > now ? startAt : null;
  const estimatedEndAt = new Date(
    (scheduledStart ?? now).getTime() + durationHours * 60 * 60 * 1000
  );

  return (
    <Paper p="lg" className="border border-blue-500/30 bg-blue-500/5">
      <Group gap="xs" mb="md">
        <IconCalendar size={20} className="text-blue-5" />
        <Text fw={600}>Estimated Schedule</Text>
      </Group>
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <IconClock size={16} className="text-green-5" />
            <Text c="dimmed">Starts</Text>
          </Group>
          <Text fw={500} c="green">
            {scheduledStart ? formatDateTime(scheduledStart) : capitalize(startNowLabel)}
          </Text>
        </Group>
        <Group justify="space-between">
          <Group gap="xs">
            <IconClock size={16} className="text-orange-5" />
            <Text c="dimmed">Ends</Text>
          </Group>
          <Text fw={500} c="orange">
            {scheduledStart ? '' : '~'}
            {formatDateTime(estimatedEndAt)}
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          {localTimeNote}
        </Text>
      </Stack>
    </Paper>
  );
}

function CostRow({
  label,
  amount,
  buzzType,
  zeroLabel = 'Free',
}: {
  label: string;
  amount: number;
  buzzType: CrucibleBuzzType;
  zeroLabel?: string;
}) {
  return (
    <Group justify="space-between">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      {amount === 0 ? (
        <Text size="sm" fw={600}>
          {zeroLabel}
        </Text>
      ) : (
        <BuzzAmount amount={amount} buzzType={buzzType} prefix="+" />
      )}
    </Group>
  );
}

function formatPlace(position: string, withPlace = true) {
  const num = parseInt(position);
  const j = num % 10;
  const k = num % 100;
  const suffix =
    j === 1 && k !== 11 ? 'st' : j === 2 && k !== 12 ? 'nd' : j === 3 && k !== 13 ? 'rd' : 'th';
  return `${num}${suffix}${withPlace ? ' Place' : ''}`;
}
