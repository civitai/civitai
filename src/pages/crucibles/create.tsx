import {
  ActionIcon,
  Button,
  Container,
  Grid,
  Group,
  Input,
  Paper,
  Progress,
  SimpleGrid,
  Slider,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowBackUp,
  IconArrowLeft,
  IconCalendar,
  IconCheck,
  IconClock,
  IconInfoCircle,
  IconPencil,
  IconPhoto,
  IconPlus,
  IconTicket,
  IconTrash,
  IconTrophy,
  IconVideo,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import * as z from 'zod';

import { BackButton } from '~/components/BackButton/BackButton';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { ContentRatingSelect } from '~/components/Challenge/ContentRatingSelect';
import { ModelVersionMultiSelect } from '~/components/Challenge/ModelVersionMultiSelect';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useStepper } from '~/hooks/useStepper';
import {
  Form,
  InputDateTimePicker,
  InputNumber,
  InputSelect,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { withController } from '~/libs/form/hoc/withController';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import {
  CRUCIBLE_CONTENT_TYPES,
  CRUCIBLE_DURATION_COSTS,
  CRUCIBLE_MAX_CLIP_SECONDS_OPTIONS,
  CRUCIBLE_MAX_ENTRY_FEE,
  CRUCIBLE_MIN_VIEW_SECONDS_OPTIONS,
  CRUCIBLE_MAX_SEEDED_PRIZE_POOL,
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
  CRUCIBLE_RESOURCE_REQUIREMENTS_COST,
  getMaxCrucibleStartAt,
  type CrucibleContentType,
} from '~/shared/constants/crucible.constants';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { Currency, MediaType } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const InputContentRatingSelect = withController(ContentRatingSelect);
const InputModelVersionMultiSelect = withController(ModelVersionMultiSelect);

const durationOptions = [
  { value: 8, label: '8 hours' },
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

const entryLimitOptions = [1, 2, 3, 5, 10].map((value) => ({
  value,
  label: `${value} ${value === 1 ? 'entry' : 'entries'}`,
}));

const formatSeconds = (seconds: number) =>
  seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;

// 0 is the select's "no rule" choice; the server spells that as an absent value.
const NO_RULE = 0;
const toVideoRule = (seconds: number | undefined) => seconds || undefined;

const defaultPrizePositions: Record<string, number> = {
  '1': 50,
  '2': 30,
  '3': 20,
};

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  description: z.string().trim().max(500).optional(),
  duration: z.number(),
  startAt: z.date().nullish(),
  nsfwLevel: z.number(),
  contentType: z.enum(CRUCIBLE_CONTENT_TYPES),
  entryFee: z.number({ error: 'Entry fee is required' }).int().min(0).max(CRUCIBLE_MAX_ENTRY_FEE),
  entryLimit: z.number().int().min(1).max(10),
  maxTotalEntries: z.number().int().min(1).optional(),
  allowedResources: z.array(z.number()).optional(),
  minViewSeconds: z.number().optional(),
  maxClipSeconds: z.number().optional(),
  seededPrizePool: z
    .number({ error: 'Enter 0 for no seed' })
    .int()
    .min(0)
    .max(CRUCIBLE_MAX_SEEDED_PRIZE_POOL),
  prizePositions: z.record(z.string(), z.number()),
});
type FormValues = z.infer<typeof formSchema>;

const defaultValues: FormValues = {
  name: '',
  description: '',
  duration: 8,
  nsfwLevel: 1,
  contentType: MediaType.image,
  entryFee: 100,
  entryLimit: 1,
  allowedResources: [],
  seededPrizePool: 0,
  prizePositions: { ...defaultPrizePositions },
};

const stepFields: Record<number, (keyof FormValues)[]> = {
  1: ['name', 'description', 'duration', 'startAt', 'nsfwLevel'],
  2: [
    'contentType',
    'entryFee',
    'entryLimit',
    'maxTotalEntries',
    'minViewSeconds',
    'maxClipSeconds',
  ],
  3: ['seededPrizePool'],
};

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx, features }) => {
    if (!features?.crucible) return { notFound: true };

    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'create-crucible' }),
          permanent: false,
        },
      };
    if (session.user?.muted) return { notFound: true };
  },
});

export default function CrucibleCreate() {
  const router = useRouter();
  const [currentStep, { goToNextStep, goToPrevStep, setStep }] = useStepper(4);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // The wizard unmounts each step's inputs, so they must keep their values when unregistered.
  const form = useForm({ schema: formSchema, defaultValues, shouldUnregister: false });
  const values = form.watch();

  const createCrucibleMutation = trpc.crucible.create.useMutation({
    onSuccess: (data) => {
      showSuccessNotification({
        title: 'Crucible Created!',
        message: 'Your crucible has been created successfully. Redirecting...',
      });
      router.push(`/crucibles/${data.id}`);
    },
    onError: (error) => {
      setIsSubmitting(false);
      showErrorNotification({
        title: 'Failed to create crucible',
        error: { message: error.message },
      });
    },
  });

  const [prizeEditMode, setPrizeEditMode] = useState(false);
  const [prizeCustomized, setPrizeCustomized] = useState(false);

  const { files: imageFiles, uploadToCF, removeImage, resetFiles } = useCFImageUpload();
  const imageFile = imageFiles[0];

  const handleDropImages = async (droppedFiles: File[]) => {
    resetFiles();
    for (const file of droppedFiles) {
      uploadToCF(file);
    }
  };

  const setPrizePositions = (prizePositions: Record<string, number>) =>
    form.setValue('prizePositions', prizePositions);

  const isStep1Valid = () => values.name.trim().length > 0 && imageFile?.status === 'success';

  // Mirrors the server's cross-field refine. Both set and inverted means nothing can clear the
  // bar, so the crucible would have nothing votable in it.
  const minViewSeconds = toVideoRule(values.minViewSeconds);
  const maxClipSeconds = toVideoRule(values.maxClipSeconds);
  const videoSettingsError =
    minViewSeconds != null && maxClipSeconds != null && minViewSeconds > maxClipSeconds
      ? 'Minimum view time cannot exceed the maximum clip length'
      : null;

  const isStep2Valid = () =>
    values.entryFee != null &&
    values.entryLimit >= 1 &&
    values.entryLimit <= 10 &&
    !videoSettingsError;

  const totalPrizePercentage = Object.values(values.prizePositions).reduce(
    (sum, val) => sum + val,
    0
  );
  const isStep3Valid = () => values.seededPrizePool != null && totalPrizePercentage <= 100;

  const durationCost = CRUCIBLE_DURATION_COSTS[values.duration] ?? 0;
  const prizeCustomizationCost = prizeCustomized ? CRUCIBLE_PRIZE_CUSTOMIZATION_COST : 0;
  const resourceRequirementsCost = values.allowedResources?.length
    ? CRUCIBLE_RESOURCE_REQUIREMENTS_COST
    : 0;
  const totalCost =
    durationCost +
    prizeCustomizationCost +
    resourceRequirementsCost +
    (values.seededPrizePool ?? 0);

  const addPrizePosition = () => {
    const nextPosition = Object.keys(values.prizePositions).length + 1;
    setPrizePositions({ ...values.prizePositions, [nextPosition.toString()]: 0 });
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
    setPrizePositions({ ...defaultPrizePositions });
    setPrizeCustomized(false);
    setPrizeEditMode(false);
  };

  const enterPrizeEditMode = () => {
    setPrizeEditMode(true);
    setPrizeCustomized(true);
  };

  const handleNext = async () => {
    const fields = stepFields[currentStep];
    if (fields && !(await form.trigger(fields))) return;
    if (currentStep === 1 && !isStep1Valid()) return;
    if (currentStep === 2 && !isStep2Valid()) return;
    if (currentStep === 3 && !isStep3Valid()) return;
    goToNextStep();
  };

  const handleSubmit = (data: FormValues) => {
    if (isSubmitting) return;

    if (!imageFile || imageFile.status !== 'success') {
      showErrorNotification({
        title: 'Missing Cover Image',
        error: { message: 'Please upload a cover image for your crucible.' },
      });
      return;
    }

    setIsSubmitting(true);

    const isVideo = data.contentType === MediaType.video;
    createCrucibleMutation.mutate({
      name: data.name,
      description: data.description || 'No description provided',
      coverImage: {
        url: imageFile.url,
        width: imageFile.width,
        height: imageFile.height,
        hash: imageFile.hash,
      },
      nsfwLevel: data.nsfwLevel,
      contentType: data.contentType,
      entryFee: data.entryFee,
      entryLimit: data.entryLimit,
      maxTotalEntries: data.maxTotalEntries,
      allowedResources: data.allowedResources?.length ? data.allowedResources : undefined,
      prizePositions: data.prizePositions,
      seededPrizePool: data.seededPrizePool,
      prizeCustomized,
      duration: data.duration,
      startAt: data.startAt ?? undefined,
      minViewSeconds: isVideo ? toVideoRule(data.minViewSeconds) : undefined,
      maxClipSeconds: isVideo ? toVideoRule(data.maxClipSeconds) : undefined,
    });
  };

  const renderStep1 = () => (
    <Stack gap="xl">
      <div>
        <Input.Wrapper
          label="Cover Image"
          description="This image appears on discovery cards (16:9 aspect ratio recommended)"
          withAsterisk
        >
          {imageFile && imageFile.progress < 100 ? (
            <Paper
              style={{ position: 'relative', marginTop: 5, width: '100%', height: 200 }}
              withBorder
            >
              <div className="flex h-full items-center justify-center">
                <Progress.Root size="xl" w="80%">
                  <Progress.Section
                    striped
                    animated
                    value={imageFile.progress}
                    color={imageFile.progress < 100 ? 'blue' : 'green'}
                  >
                    <Progress.Label>{Math.floor(imageFile.progress)}%</Progress.Label>
                  </Progress.Section>
                </Progress.Root>
              </div>
            </Paper>
          ) : imageFile?.status === 'success' ? (
            <div style={{ position: 'relative', width: '100%', marginTop: 8 }}>
              <Tooltip label="Remove image">
                <LegacyActionIcon
                  size="sm"
                  variant="filled"
                  color="red"
                  onClick={() => removeImage(imageFile.url)}
                  className="absolute right-2 top-2 z-10"
                >
                  <IconTrash size={14} />
                </LegacyActionIcon>
              </Tooltip>
              <div className="overflow-hidden rounded-lg" style={{ aspectRatio: '16 / 9' }}>
                <EdgeMedia
                  src={imageFile.objectUrl ?? imageFile.url}
                  width={800}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </div>
            </div>
          ) : (
            <ImageDropzone
              mt={8}
              onDrop={handleDropImages}
              count={imageFiles.length}
              accept={IMAGE_MIME_TYPE}
              label="Drag & drop cover image here or click to browse"
            />
          )}
        </Input.Wrapper>
      </div>

      <InputText
        name="name"
        label="Crucible Name"
        description="Maximum 100 characters"
        placeholder="e.g., Anime Character Design Challenge"
        maxLength={100}
        withAsterisk
      />

      <InputTextArea
        name="description"
        label="Description"
        description="Describe the theme, rules, or inspiration. Maximum 500 characters. (Optional)"
        placeholder="e.g., Design an original anime character set in a neon-lit cyberpunk city. Show the full outfit, and keep it an original character — no fan art of existing ones."
        maxLength={500}
        autosize
        minRows={3}
      />

      <Input.Wrapper
        label="Duration"
        description="Duration determines how long the crucible accepts entries"
        withAsterisk
      >
        <SimpleGrid cols={{ base: 2, sm: 4 }} mt={8}>
          {durationOptions.map((option) => (
            <Paper
              key={option.value}
              className={`cursor-pointer border p-3 text-center transition-all ${
                values.duration === option.value
                  ? 'border-blue-500 bg-blue-500/20'
                  : 'border-dark-4 hover:border-blue-500'
              }`}
              onClick={() => form.setValue('duration', option.value)}
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
                  <Group gap={4} justify="center">
                    <CurrencyIcon currency={Currency.BUZZ} size={12} />
                    <Text size="xs" c="yellow" fw={700}>
                      +{option.cost.toLocaleString()}
                    </Text>
                  </Group>
                )}
              </div>
            </Paper>
          ))}
        </SimpleGrid>
      </Input.Wrapper>

      <InputDateTimePicker
        name="startAt"
        label="Start Date"
        description="Leave empty to start the crucible as soon as you create it"
        placeholder="Start immediately"
        valueFormat="lll"
        minDate={new Date()}
        maxDate={getMaxCrucibleStartAt()}
        clearable
      />

      <InputContentRatingSelect
        name="nsfwLevel"
        label="Allowed Content Levels"
        description="Users can only submit content matching these levels"
      />
    </Stack>
  );

  const renderStep2 = () => (
    <Stack gap="xl">
      <Input.Wrapper
        label="Content Type"
        description="What entrants submit and judges compare"
        withAsterisk
      >
        <SimpleGrid cols={2} mt={8}>
          {contentTypeOptions.map(({ value, label, Icon }) => (
            <Paper
              key={value}
              className={`cursor-pointer border p-3 transition-all ${
                values.contentType === value
                  ? 'border-blue-500 bg-blue-500/20'
                  : 'border-dark-4 hover:border-blue-500'
              }`}
              onClick={() => {
                form.setValue('contentType', value);
                if (value !== MediaType.video) {
                  form.setValue('minViewSeconds', undefined);
                  form.setValue('maxClipSeconds', undefined);
                }
              }}
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
        }`}
        leftSection={<CurrencyIcon currency={Currency.BUZZ} size={16} />}
        min={0}
        max={CRUCIBLE_MAX_ENTRY_FEE}
        step={10}
        allowNegative={false}
        allowDecimal={false}
        clampBehavior="blur"
      />

      <InputSelect
        name="entryLimit"
        label="Entry Limit per User"
        description="How many times can one user enter?"
        data={entryLimitOptions}
        allowDeselect={false}
        withAsterisk
      />

      <InputNumber
        name="maxTotalEntries"
        label="Maximum Total Entries"
        description="Optional limit on total entries across all users"
        placeholder="No limit"
        min={1}
        allowNegative={false}
        allowDecimal={false}
        clampBehavior="blur"
        clearable
      />

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
            <span className="rounded bg-yellow-500/20 px-2 py-0.5 text-xs font-bold text-yellow-4">
              +{CRUCIBLE_RESOURCE_REQUIREMENTS_COST.toLocaleString()} Buzz
            </span>
          </Group>
        }
        description="Entries must use at least one of the selected models. Leave empty to allow any model."
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
        description="Add your own Buzz on top of what entry fees collect. Charged when you create the crucible."
        leftSection={<CurrencyIcon currency={Currency.BUZZ} size={16} />}
        min={0}
        max={CRUCIBLE_MAX_SEEDED_PRIZE_POOL}
        step={100}
        allowNegative={false}
        allowDecimal={false}
        clampBehavior="blur"
      />
    );

    if (!prizeEditMode) {
      return (
        <Stack gap="lg">
          {seededPoolInput}

          <div>
            <Text size="xs" c="dimmed" fw={600} mb={8}>
              {prizeCustomized ? 'Custom Distribution' : 'Default Distribution'}
            </Text>
            <PrizeDistributionChart prizePositions={values.prizePositions} />
          </div>

          <Button
            variant="filled"
            color="blue"
            onClick={enterPrizeEditMode}
            leftSection={<IconPencil size={16} />}
            rightSection={
              !prizeCustomized && (
                <span className="ml-2 rounded bg-yellow-500/20 px-2 py-0.5 text-xs font-bold text-yellow-4">
                  +{CRUCIBLE_PRIZE_CUSTOMIZATION_COST.toLocaleString()} Buzz
                </span>
              )
            }
          >
            {prizeCustomized ? 'Edit Distribution' : 'Customize Distribution'}
          </Button>
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

        {sortedPositions.map(([position, percentage], index) => (
          <Paper key={position} p="md" className="border border-dark-4">
            <Group justify="space-between" align="center" gap="md">
              <Text size="sm" fw={600} style={{ width: 90 }}>
                {formatPlace(position)}
              </Text>
              <Slider
                value={percentage}
                onChange={(value) =>
                  setPrizePositions({ ...values.prizePositions, [position]: value })
                }
                min={0}
                max={100}
                step={1}
                style={{ flex: 1 }}
                color={positionColors[index]?.slider ?? 'gray'}
                styles={{
                  track: { height: 6 },
                  thumb: { borderWidth: 2 },
                }}
              />
              <Text size="sm" fw={700} style={{ width: 50, textAlign: 'right' }}>
                {percentage}%
              </Text>
              {parseInt(position) > 3 && (
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size="sm"
                  onClick={() => removePrizePosition(position)}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              )}
            </Group>
          </Paper>
        ))}

        <Button
          variant="light"
          color="blue"
          onClick={addPrizePosition}
          leftSection={<IconPlus size={16} />}
        >
          Add Prize Position
        </Button>

        <Paper p="md" className="border border-dark-4" bg="dark.7">
          <Group justify="space-between">
            <Text c="dimmed">Total Distribution</Text>
            <Text size="lg" fw={700} c={totalPrizePercentage <= 100 ? 'green' : 'red'}>
              {totalPrizePercentage}%
            </Text>
          </Group>
          {totalPrizePercentage > 100 && (
            <Text size="xs" c="red" mt={4}>
              Prize percentages cannot exceed 100%
            </Text>
          )}
        </Paper>

        <Group gap="md">
          <Button
            variant="light"
            color="gray"
            onClick={resetPrizeDistribution}
            leftSection={<IconArrowBackUp size={16} />}
            style={{ flex: 1 }}
          >
            Reset to Default
          </Button>
          <Button
            variant="filled"
            color="blue"
            onClick={() => setPrizeEditMode(false)}
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
      <Title order={3}>Review Your Crucible</Title>

      <EstimatedSchedule durationHours={values.duration} startAt={values.startAt} />

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
            <Text c="dimmed">Entry Fee</Text>
            <CurrencyBadge unitAmount={values.entryFee ?? 0} currency={Currency.BUZZ} />
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">Entry Limit per User</Text>
            <Text fw={500}>
              {entryLimitOptions.find((o) => o.value === values.entryLimit)?.label}
            </Text>
          </Group>
          <Group justify="space-between">
            <Text c="dimmed">Max Total Entries</Text>
            <Text fw={500}>{values.maxTotalEntries || 'Unlimited'}</Text>
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
              <CurrencyBadge unitAmount={values.seededPrizePool} currency={Currency.BUZZ} />
            ) : (
              <Text fw={500}>None</Text>
            )}
          </Group>
          <PrizeDistributionChart prizePositions={values.prizePositions} />
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

  const stepLabels = ['Basic Info', 'Entry Rules', 'Prizes', 'Review'];

  return (
    <Container size="lg" py="xl">
      <Form form={form}>
        <Grid gutter="xl">
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <Group gap="md" mb="xl">
              <BackButton url="/crucibles" />
              <div>
                <Title order={2}>Create Crucible</Title>
                <Text c="dimmed" size="sm">
                  Set up a new creative competition
                </Text>
              </div>
            </Group>

            <Group gap="xs" mb="xl">
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
                onClick={goToPrevStep}
                disabled={currentStep === 1}
                leftSection={<IconArrowLeft size={16} />}
              >
                Previous
              </Button>
              {currentStep < 4 && (
                <Button
                  onClick={handleNext}
                  disabled={
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
              <Paper className="mb-4 overflow-hidden border border-dark-4">
                <div
                  className="flex items-center justify-center bg-gradient-to-br from-dark-6 to-dark-8"
                  style={{ aspectRatio: '16 / 9' }}
                >
                  {imageFile?.status === 'success' ? (
                    <EdgeMedia
                      src={imageFile.objectUrl ?? imageFile.url}
                      width={400}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <Text c="dimmed" size="xs">
                      No cover image
                    </Text>
                  )}
                </div>
                <div className="p-3">
                  <Text size="sm" fw={600} lineClamp={2} mb="sm">
                    {values.name || 'Your Crucible Name'}
                  </Text>
                  <Group justify="space-between" gap={4}>
                    <Stack gap={2} align="flex-start">
                      {values.entryFee ? (
                        <CurrencyBadge unitAmount={values.entryFee} currency={Currency.BUZZ} />
                      ) : (
                        <Text size="sm" fw={600}>
                          Free
                        </Text>
                      )}
                      <Text size="xs" c="dimmed">
                        Entry Fee
                      </Text>
                    </Stack>
                    <Stack gap={2} align="flex-end">
                      <Text size="sm" fw={600}>
                        {getDurationLabel(values.duration)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        Duration
                      </Text>
                    </Stack>
                  </Group>
                </div>
              </Paper>

              {currentStep === 4 && (
                <BuzzTransactionButton
                  fullWidth
                  size="lg"
                  mb="md"
                  buzzAmount={totalCost}
                  accountTypes={['yellow', 'green']}
                  label="Create Crucible"
                  loading={isSubmitting}
                  onPerformTransaction={form.handleSubmit(handleSubmit)}
                  showPurchaseModal
                />
              )}

              <Paper p="md" className="border border-dark-4">
                <Text size="xs" c="dimmed" fw={600} mb="md" tt="uppercase">
                  Cost Breakdown
                </Text>
                <Stack gap="xs">
                  <CostRow label="Duration" amount={durationCost} />
                  <CostRow label="Entry Limit" amount={0} />
                  <CostRow label="Prize Customization" amount={prizeCustomizationCost} />
                  <CostRow label="Resource Requirements" amount={resourceRequirementsCost} />
                  <CostRow
                    label="Seeded Prize Pool"
                    amount={values.seededPrizePool ?? 0}
                    zeroLabel="None"
                  />
                  <div className="mt-2 border-t border-dark-4 pt-3">
                    <Group justify="space-between">
                      <Text size="sm" fw={600}>
                        Total Cost
                      </Text>
                      <Text size="md" c="yellow" fw={700}>
                        {totalCost === 0 ? 'Free' : `${totalCost.toLocaleString()} Buzz`}
                      </Text>
                    </Group>
                  </div>
                </Stack>
              </Paper>
            </div>
          </Grid.Col>
        </Grid>
      </Form>
    </Container>
  );
}

const positionColors = [
  { bar: 'from-blue-500 to-blue-600', slider: 'blue' },
  { bar: 'from-green-500 to-green-600', slider: 'green' },
  { bar: 'from-yellow-500 to-yellow-600', slider: 'yellow' },
];

function PrizeDistributionChart({ prizePositions }: { prizePositions: Record<string, number> }) {
  const sortedPositions = Object.entries(prizePositions).sort(
    ([a], [b]) => parseInt(a) - parseInt(b)
  );

  return (
    <Stack gap="md">
      <div className="flex h-8 overflow-hidden rounded border border-dark-4">
        {sortedPositions.map(([position, percentage], index) => (
          <div
            key={position}
            className={`flex items-center justify-center bg-gradient-to-r text-xs font-bold text-white ${
              positionColors[index]?.bar ?? 'from-gray-500 to-gray-600'
            }`}
            style={{ flex: percentage || 0.1 }}
          >
            {percentage > 10 && `${formatPlace(position, false)}: ${percentage}%`}
          </div>
        ))}
      </div>

      <SimpleGrid cols={{ base: 2, sm: 3 }}>
        {sortedPositions.slice(0, 3).map(([position, percentage]) => (
          <Paper key={position} p="md" className="border border-dark-4 text-center" bg="dark.7">
            <Text size="xs" c="dimmed" mb={6}>
              {formatPlace(position)}
            </Text>
            <Text size="xl" fw={700}>
              {percentage}%
            </Text>
          </Paper>
        ))}
      </SimpleGrid>

      {sortedPositions.length > 3 && (
        <Paper p="md" className="border border-dark-4">
          <Stack gap="xs">
            {sortedPositions.slice(3).map(([position, percentage]) => (
              <Group key={position} justify="space-between">
                <Text size="sm" c="dimmed">
                  {formatPlace(position)}
                </Text>
                <Text size="sm" fw={600}>
                  {percentage}%
                </Text>
              </Group>
            ))}
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
}: {
  durationHours: number;
  startAt?: Date | null;
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
            {scheduledStart ? formatDateTime(scheduledStart) : 'As soon as you create it'}
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
      </Stack>
    </Paper>
  );
}

function CostRow({
  label,
  amount,
  zeroLabel = 'Free',
}: {
  label: string;
  amount: number;
  zeroLabel?: string;
}) {
  return (
    <Group justify="space-between">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" c="yellow" fw={600}>
        {amount === 0 ? zeroLabel : `+${amount.toLocaleString()} Buzz`}
      </Text>
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
