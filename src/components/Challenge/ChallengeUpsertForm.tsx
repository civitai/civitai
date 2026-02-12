import type { SelectProps } from '@mantine/core';
import {
  Alert,
  Button,
  Divider,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import dayjs from '~/shared/utils/dayjs';
import { useRouter } from 'next/router';
import React from 'react';
import * as z from 'zod';
import { BackButton } from '~/components/BackButton/BackButton';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { ModelVersionMultiSelect } from '~/components/Challenge/ModelVersionMultiSelect';
import { ContentRatingSelect } from '~/components/Challenge/ContentRatingSelect';
import {
  Form,
  InputDateTimePicker,
  InputNumber,
  InputRTE,
  InputSelect,
  InputSimpleImageUpload,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { withController } from '~/libs/form/hoc/withController';
import { trpc } from '~/utils/trpc';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import {
  ChallengeSource,
  ChallengeStatus,
  Currency,
  PrizeMode,
  PoolTrigger,
} from '~/shared/utils/prisma/enums';
import { upsertChallengeBaseSchema, type Prize } from '~/server/schema/challenge.schema';
import { computeDynamicPool } from '~/server/games/daily-challenge/challenge-pool';
import type { GetActiveJudgesItem } from '~/types/router';
import { IconCheck } from '@tabler/icons-react';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

// Wrapped custom components for form integration
const InputModelVersionMultiSelect = withController(ModelVersionMultiSelect);
const InputContentRatingSelect = withController(ContentRatingSelect);
const InputNumberWrapper = withController(NumberInputWrapper);

// Form schema - extends server schema with flattened prize fields for UI
// judgeId is overridden to string|null because Mantine Select uses string values
// Note: cannot use .refine() here because useForm casts schema to ZodObject to access .shape
const schema = upsertChallengeBaseSchema
  .omit({ prizes: true, entryPrize: true, judgeId: true, eventId: true })
  .extend({
    judgeId: z.string().nullish().default('1'),
    eventId: z.string().nullish().default(null),
    coverImage: z
      .object({ id: z.number().optional(), url: z.string() })
      .refine((val) => !!val.url, { error: 'Cover image is required' }),
    prize1Buzz: z.number().min(0).default(5000),
    prize2Buzz: z.number().min(0).default(2500),
    prize3Buzz: z.number().min(0).default(1000),
    entryPrizeBuzz: z.number().min(0).default(0),
    prizeMode: z.nativeEnum(PrizeMode).default(PrizeMode.Fixed),
    basePrizePool: z.number().min(0).default(2500),
    buzzPerAction: z.number().min(0).default(1),
    poolTrigger: z.nativeEnum(PoolTrigger).default(PoolTrigger.Entry),
    maxPrizePool: z.number().min(0).optional().nullable(),
    dist1: z.number().min(0).max(100).default(50),
    dist2: z.number().min(0).max(100).default(30),
    dist3: z.number().min(0).max(100).default(20),
  });

type ChallengeForEdit = {
  id: number;
  title: string;
  description: string | null;
  theme: string | null;
  invitation: string | null;
  coverImage: { id: number; url: string } | null;
  modelVersionIds: number[];
  nsfwLevel: number;
  allowedNsfwLevel: number;
  judgeId: number | null;
  eventId: number | null;
  judgingPrompt: string | null;
  reviewPercentage: number;
  maxEntriesPerUser: number;
  entryPrizeRequirement: number;
  prizePool: number;
  operationBudget: number;
  startsAt: Date;
  endsAt: Date;
  visibleAt: Date;
  status: ChallengeStatus;
  source: ChallengeSource;
  prizes: Prize[];
  entryPrize: Prize | null;
  prizeMode: PrizeMode;
  basePrizePool: number;
  buzzPerAction: number;
  poolTrigger: PoolTrigger | null;
  maxPrizePool: number | null;
  prizeDistribution: number[] | null;
};

type Props = {
  challenge?: ChallengeForEdit;
};

export function ChallengeUpsertForm({ challenge }: Props) {
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const isEditing = !!challenge;
  const isActive = challenge?.status === ChallengeStatus.Active;
  const isTerminal =
    challenge?.status === ChallengeStatus.Completed ||
    challenge?.status === ChallengeStatus.Cancelled;

  // Fetch available judges and events for dropdowns
  const { data: judges = [] } = trpc.challenge.getJudges.useQuery();
  const { data: events = [] } = trpc.challenge.getEvents.useQuery({ activeOnly: false });

  // Default dates
  const defaultStartsAt = dayjs().add(1, 'day').startOf('day').toDate();
  const defaultEndsAt = dayjs().add(2, 'day').startOf('day').toDate();
  const defaultVisibleAt = dayjs().startOf('day').toDate();

  // Parse existing prizes
  const existingPrizes = challenge?.prizes ?? [];
  const existingEntryPrize = challenge?.entryPrize;

  const form = useForm({
    schema,
    defaultValues: {
      title: challenge?.title ?? '',
      description: challenge?.description ?? '',
      theme: challenge?.theme ?? '',
      invitation: challenge?.invitation ?? '',
      coverImage: challenge?.coverImage ?? undefined,
      modelVersionIds: challenge?.modelVersionIds ?? [],
      nsfwLevel: challenge?.nsfwLevel ?? 1,
      allowedNsfwLevel: challenge?.allowedNsfwLevel ?? sfwBrowsingLevelsFlag,
      judgeId: challenge?.judgeId ? String(challenge.judgeId) : '1',
      eventId: challenge?.eventId ? String(challenge.eventId) : null,
      judgingPrompt: challenge?.judgingPrompt ?? '',
      reviewPercentage: challenge?.reviewPercentage ?? 100,
      maxEntriesPerUser: challenge?.maxEntriesPerUser ?? 20,
      entryPrizeRequirement: challenge?.entryPrizeRequirement ?? 10,
      prizePool: challenge?.prizePool ?? 0,
      operationBudget: challenge?.operationBudget ?? 0,
      startsAt: challenge?.startsAt ?? defaultStartsAt,
      endsAt: challenge?.endsAt ?? defaultEndsAt,
      visibleAt: challenge?.visibleAt ?? defaultVisibleAt,
      source: challenge?.source ?? ChallengeSource.Mod,
      prize1Buzz: existingPrizes[0]?.buzz ?? 5000,
      prize2Buzz: existingPrizes[1]?.buzz ?? 2500,
      prize3Buzz: existingPrizes[2]?.buzz ?? 1000,
      entryPrizeBuzz: existingEntryPrize?.buzz ?? 0,
      prizeMode: challenge?.prizeMode ?? PrizeMode.Fixed,
      basePrizePool: challenge?.basePrizePool ?? 2500,
      buzzPerAction: challenge?.buzzPerAction ?? 1,
      poolTrigger: challenge?.poolTrigger || PoolTrigger.Entry,
      maxPrizePool: challenge?.maxPrizePool ?? undefined,
      dist1: challenge?.prizeDistribution?.[0] ?? 50,
      dist2: challenge?.prizeDistribution?.[1] ?? 30,
      dist3: challenge?.prizeDistribution?.[2] ?? 20,
    },
  });

  const upsertMutation = trpc.challenge.upsert.useMutation({
    onSuccess: () => {
      queryUtils.challenge.getModeratorList.invalidate();
      showSuccessNotification({
        message: isEditing ? 'Challenge updated successfully' : 'Challenge created successfully',
      });
      router.push('/moderator/challenges');
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const handleSubmit = (data: z.infer<typeof schema>) => {
    // Cross-field date validation (can't use .refine() because useForm accesses .shape)
    if (data.endsAt <= data.startsAt) {
      form.setError('endsAt', { message: 'End date must be after start date' });
      return;
    }

    // Shared fields for both modes
    const sharedFields = {
      id: challenge?.id,
      title: data.title,
      description: data.description || undefined,
      theme: data.theme || undefined,
      invitation: data.invitation || undefined,
      coverImage: data.coverImage ?? undefined,
      modelVersionIds: data.modelVersionIds,
      nsfwLevel: data.nsfwLevel,
      allowedNsfwLevel: data.allowedNsfwLevel,
      judgeId: data.judgeId ? Number(data.judgeId) : null,
      eventId: data.eventId ? Number(data.eventId) : null,
      judgingPrompt: data.judgingPrompt || undefined,
      reviewPercentage: data.reviewPercentage,
      maxEntriesPerUser: data.maxEntriesPerUser,
      entryPrizeRequirement: data.entryPrizeRequirement,
      operationBudget: data.operationBudget,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      visibleAt: data.visibleAt,
      source: data.source,
    };

    if (data.prizeMode === PrizeMode.Dynamic) {
      // Validate distribution sums to 100
      const distTotal = (data.dist1 ?? 0) + (data.dist2 ?? 0) + (data.dist3 ?? 0);
      if (distTotal !== 100) {
        form.setError('dist1', { message: 'Distribution must sum to 100%' });
        return;
      }
      // Validate cap >= base if set
      if (data.maxPrizePool != null && data.maxPrizePool < data.basePrizePool) {
        form.setError('maxPrizePool', { message: 'Cap must be >= base prize pool' });
        return;
      }

      const distribution = [data.dist1, data.dist2, data.dist3];
      const { totalPool, prizes } = computeDynamicPool({
        basePrizePool: data.basePrizePool,
        buzzPerAction: 0, // At creation time, no entries yet — pool starts at base
        actionCount: 0,
        maxPrizePool: data.maxPrizePool ?? null,
        prizeDistribution: distribution,
      });
      const entryPrize: Prize | null =
        data.entryPrizeBuzz > 0 ? { buzz: data.entryPrizeBuzz, points: 10 } : null;

      upsertMutation.mutate({
        ...sharedFields,
        prizeMode: data.prizeMode,
        basePrizePool: data.basePrizePool,
        buzzPerAction: data.buzzPerAction,
        poolTrigger: data.poolTrigger,
        maxPrizePool: data.maxPrizePool ?? null,
        prizeDistribution: distribution,
        prizePool: totalPool,
        prizes,
        entryPrize,
      });
      return;
    }

    // Fixed mode (original logic)
    const prizes: Prize[] = [
      { buzz: data.prize1Buzz, points: 150 },
      { buzz: data.prize2Buzz, points: 100 },
      { buzz: data.prize3Buzz, points: 50 },
    ].filter((p) => p.buzz > 0);

    const entryPrize: Prize | null =
      data.entryPrizeBuzz > 0 ? { buzz: data.entryPrizeBuzz, points: 10 } : null;

    const fixedPrizePool = prizes.reduce((sum, p) => sum + p.buzz, 0);

    upsertMutation.mutate({
      ...sharedFields,
      prizeMode: PrizeMode.Fixed,
      poolTrigger: null,
      prizeDistribution: null,
      prizePool: fixedPrizePool,
      prizes,
      entryPrize,
    });
  };

  // Watch prize values for total calculation
  const [prize1, prize2, prize3] = form.watch(['prize1Buzz', 'prize2Buzz', 'prize3Buzz']);
  const prizeMode = form.watch('prizeMode') ?? PrizeMode.Fixed;
  const [dist1, dist2, dist3] = form.watch(['dist1', 'dist2', 'dist3']);
  const basePrizePool = form.watch('basePrizePool') ?? 0;
  const maxPrizePool = form.watch('maxPrizePool');
  const totalPct = (dist1 || 0) + (dist2 || 0) + (dist3 || 0);
  // For Dynamic mode: show max pool if set (assume we'll hit it), otherwise base
  const dynamicDisplayPool = maxPrizePool != null && maxPrizePool > 0 ? maxPrizePool : basePrizePool;
  const totalPrizePool =
    prizeMode === PrizeMode.Dynamic
      ? dynamicDisplayPool
      : (prize1 || 0) + (prize2 || 0) + (prize3 || 0);

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack gap="md">
        {/* Header */}
        <Group wrap="wrap">
          <BackButton url="/moderator/challenges" />
          <Title order={2} size="h3" className="sm:text-2xl">
            {isEditing ? 'Edit Challenge' : 'Create Challenge'}
          </Title>
        </Group>

        {isTerminal && (
          <Alert color="red" title="Challenge is read-only">
            This challenge is {challenge?.status?.toLowerCase()} and cannot be edited.
          </Alert>
        )}

        {isActive && (
          <Alert color="yellow" title="Limited editing">
            Some fields are locked because this challenge is active. Fields that affect fairness for
            existing entries cannot be changed.
          </Alert>
        )}

        {/* Main Content */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>Basic Information</Title>

            <div className="flex flex-col-reverse gap-4 sm:flex-row sm:items-start sm:gap-6">
              <Stack gap="md" className="min-w-0 flex-1">
                <InputText
                  name="title"
                  label="Title"
                  placeholder="Enter challenge title"
                  withAsterisk
                  disabled={isTerminal}
                />

                <InputText
                  name="theme"
                  label="Theme"
                  placeholder="1-2 word theme (e.g., 'Neon Dreams')"
                  disabled={isTerminal}
                />

                <InputText
                  name="invitation"
                  label="Invitation"
                  placeholder="Short tagline to invite participants"
                  disabled={isTerminal}
                />
              </Stack>

              <div className="w-full sm:w-80 sm:shrink-0">
                <InputSimpleImageUpload
                  name="coverImage"
                  label="Cover Image"
                  description="Suggested size: 1024x768 (4:3 aspect ratio)"
                  aspectRatio={3 / 4}
                  style={{ maxWidth: '100%' }}
                  withAsterisk
                  withNsfwLevel={false}
                  disabled={isTerminal}
                />
              </div>
            </div>

            <InputRTE
              name="description"
              label="Description"
              placeholder="What is the challenge about? Provide details, rules, and any other information participants should know."
              includeControls={['heading', 'formatting', 'list', 'link', 'colors']}
              editorSize="lg"
              stickyToolbar
              disabled={isTerminal}
            />
          </Stack>
        </Paper>

        {/* Model Version Selection */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <InputModelVersionMultiSelect
            name="modelVersionIds"
            label="Eligible Models"
            description="Specify which models are allowed for this challenge. Entries must use at least one of the selected models (OR condition, not all). Leave empty to allow any model."
            disabled={isActive || isTerminal}
          />
        </Paper>

        {/* Timing */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>Schedule</Title>

            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              {/* Date locale is handled by DateLocaleProvider via DatesProvider */}
              <InputDateTimePicker
                name="visibleAt"
                label="Visible From"
                placeholder="When challenge appears in feed"
                valueFormat="lll"
                disabled={isTerminal}
              />

              <InputDateTimePicker
                name="startsAt"
                label="Starts At"
                placeholder="When submissions open"
                valueFormat="lll"
                disabled={isActive || isTerminal}
              />

              <InputDateTimePicker
                name="endsAt"
                label="Ends At"
                placeholder="When submissions close"
                valueFormat="lll"
                disabled={isTerminal}
              />
            </SimpleGrid>

            <Text size="sm" c="dimmed">
              All times are in{' '}
              <Text fw="bold" c="red.5" span>
                UTC
              </Text>
              . Make sure to convert from your local timezone when setting dates.
            </Text>
          </Stack>
        </Paper>

        {/* Prizes */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Group justify="space-between" wrap="wrap">
              <Title order={4}>Prizes</Title>
              <CurrencyBadge currency={Currency.BUZZ} unitAmount={totalPrizePool} size="lg" />
            </Group>

            {/* Prize Mode Toggle */}
            <SegmentedControl
              value={prizeMode}
              onChange={(val) => form.setValue('prizeMode', val as PrizeMode)}
              data={[
                { label: 'Fixed Prizes', value: PrizeMode.Fixed },
                { label: 'Dynamic Pool', value: PrizeMode.Dynamic },
              ]}
              disabled={isActive || isTerminal}
            />

            <div className={prizeMode === PrizeMode.Fixed ? '' : 'hidden'}>
              <SimpleGrid cols={{ base: 1, xs: 3 }}>
                <InputNumberWrapper
                  name="prize1Buzz"
                  label="1st Place"
                  leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                  currency={Currency.BUZZ}
                  min={0}
                  step={100}
                  disabled={isTerminal}
                />
                <InputNumberWrapper
                  name="prize2Buzz"
                  label="2nd Place"
                  leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                  currency={Currency.BUZZ}
                  min={0}
                  step={100}
                  disabled={isTerminal}
                />
                <InputNumberWrapper
                  name="prize3Buzz"
                  label="3rd Place"
                  leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                  currency={Currency.BUZZ}
                  min={0}
                  step={100}
                  disabled={isTerminal}
                />
              </SimpleGrid>
            </div>

            <div className={prizeMode === PrizeMode.Dynamic ? '' : 'hidden'}>
              <Stack gap="md">
                {/* Base Prize Pool */}
                <InputNumberWrapper
                  name="basePrizePool"
                  label="Base Prize Pool"
                  leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                  currency={Currency.BUZZ}
                  min={0}
                  step={100}
                  disabled={isActive || isTerminal}
                />

                {/* Growth Rule */}
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <InputNumberWrapper
                    name="buzzPerAction"
                    label="Buzz Per Trigger"
                    leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                    currency={Currency.BUZZ}
                    min={0}
                    step={1}
                    disabled={isActive || isTerminal}
                  />
                  <InputSelect
                    name="poolTrigger"
                    label="Growth Trigger"
                    data={[
                      { value: PoolTrigger.Entry, label: 'Per Entry' },
                      { value: PoolTrigger.User, label: 'Per Unique User' },
                    ]}
                    disabled={isActive || isTerminal}
                  />
                </SimpleGrid>

                {/* Pool Cap */}
                <InputNumberWrapper
                  name="maxPrizePool"
                  label="Max Prize Pool (optional)"
                  description="Leave empty for unlimited growth"
                  leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                  currency={Currency.BUZZ}
                  min={0}
                  step={100}
                  disabled={isActive || isTerminal}
                />

                {/* Distribution */}
                <SimpleGrid cols={3}>
                  <InputNumber
                    name="dist1"
                    label="1st Place %"
                    min={0}
                    max={100}
                    disabled={isActive || isTerminal}
                  />
                  <InputNumber
                    name="dist2"
                    label="2nd Place %"
                    min={0}
                    max={100}
                    disabled={isActive || isTerminal}
                  />
                  <InputNumber
                    name="dist3"
                    label="3rd Place %"
                    min={0}
                    max={100}
                    disabled={isActive || isTerminal}
                  />
                </SimpleGrid>
                <Group gap="md" wrap="wrap">
                  <Text size="sm" c={totalPct === 100 ? 'teal' : 'red'}>
                    {dist1 || 0} + {dist2 || 0} + {dist3 || 0} = {totalPct}%
                    {totalPct === 100 ? ' \u2713' : ' (must equal 100%)'}
                  </Text>
                  {totalPct === 100 && dynamicDisplayPool > 0 && (
                    <Text size="sm" c="dimmed">
                      1st: {Math.floor(dynamicDisplayPool * (dist1 || 0) / 100).toLocaleString()}
                      {' / '}2nd: {Math.floor(dynamicDisplayPool * (dist2 || 0) / 100).toLocaleString()}
                      {' / '}3rd: {Math.floor(dynamicDisplayPool * (dist3 || 0) / 100).toLocaleString()}
                      {' buzz'}
                    </Text>
                  )}
                </Group>
              </Stack>
            </div>

            <Divider />

            {/* Participation Prize - both modes */}
            <InputNumberWrapper
              name="entryPrizeBuzz"
              label="Participation Prize (per valid entry)"
              description="Optional buzz reward for all valid entries"
              leftSection={<CurrencyIcon currency="BUZZ" type="blue" size={16} />}
              currency={Currency.BUZZ}
              min={0}
              step={10}
              disabled={isTerminal}
            />
          </Stack>
        </Paper>

        {/* Entry Requirements */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>Entry Requirements</Title>

            {/* Content Rating Selection */}
            <InputContentRatingSelect name="allowedNsfwLevel" disabled={isActive || isTerminal} />

            <Divider />

            {/* Entry Limits */}
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <InputNumber
                name="maxEntriesPerUser"
                label="Max Entries Per User"
                description="Maximum submissions per participant"
                min={1}
                max={100}
                disabled={isActive || isTerminal}
              />

              <InputNumber
                name="entryPrizeRequirement"
                label="Entry Prize Requirement"
                description="Min entries to qualify for participation prize"
                min={1}
                max={100}
                disabled={isActive || isTerminal}
              />
            </SimpleGrid>
          </Stack>
        </Paper>

        {/* Judge */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>Judge</Title>
            <InputSelect
              classNames={{ option: '[&[data-checked="true"]]:bg-blue-9/30' }}
              name="judgeId"
              label="Assigned Judge"
              placeholder="Select a judge persona"
              description="Select a judge persona for this challenge. Leave empty for default judging."
              data={judges.map((j) => ({ value: String(j.id), label: j.name })) ?? []}
              renderOption={(item) => renderJudgeOption({ ...item, judges })}
              onChange={(value) => {
                const selectedJudge = judges.find((j) => String(j.id) === value);
                if (selectedJudge?.reviewPrompt) {
                  form.setValue('judgingPrompt', selectedJudge.reviewPrompt);
                } else {
                  form.setValue('judgingPrompt', '');
                }
              }}
              allowDeselect={false}
              disabled={isActive || isTerminal}
            />
            <InputTextArea
              name="judgingPrompt"
              label="Judging Prompt Override"
              description="Custom prompt for this challenge's AI judge. Overrides the judge persona's default prompts. Leave empty to use defaults."
              placeholder="e.g., For this holiday challenge, focus on festive themes and seasonal creativity..."
              autosize
              minRows={3}
              maxRows={8}
              disabled={isActive || isTerminal}
            />
          </Stack>
        </Paper>

        {/* Event */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>Event</Title>
            <InputSelect
              name="eventId"
              label="Challenge Event"
              placeholder="None (standalone challenge)"
              description="Assign this challenge to a featured event. Event challenges appear in the featured section on the challenges page."
              data={events.map((e) => ({
                value: String(e.id),
                label: `${e.title} (${e._count.challenges} challenges)`,
              }))}
              clearable
              disabled={isTerminal}
            />
          </Stack>
        </Paper>

        {/* Source */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>Source</Title>

            <InputSelect
              name="source"
              label="Challenge Source"
              data={[
                { value: ChallengeSource.System, label: 'System (Auto-generated)' },
                { value: ChallengeSource.Mod, label: 'Moderator' },
                { value: ChallengeSource.User, label: 'User' },
              ]}
              disabled={isActive || isTerminal}
            />
          </Stack>
        </Paper>

        {/* Actions */}
        <Group justify="flex-end" wrap="wrap">
          <Button
            variant="default"
            onClick={() => router.push('/moderator/challenges')}
            fullWidth
            className="sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            loading={form.formState.isSubmitting || upsertMutation.isPending}
            disabled={isTerminal}
            fullWidth
            className="sm:w-auto"
          >
            {isEditing ? 'Update Challenge' : 'Create Challenge'}
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

const renderJudgeOption = ({
  option,
  checked,
  judges,
}: Parameters<NonNullable<SelectProps['renderOption']>>[0] & { judges: GetActiveJudgesItem[] }) => {
  const judge = judges.find((j) => String(j.id) === option.value);

  return (
    <Stack gap={4} className="w-full">
      <Group align="center" justify="space-between" gap="sm">
        <div>
          <Text fw={500}>{option.label}</Text>
          {judge?.bio && (
            <Text size="sm" c="dimmed">
              {judge.bio}
            </Text>
          )}
        </div>
        {checked && <IconCheck stroke={1.5} color="currentColor" size={18} />}
      </Group>
    </Stack>
  );
};
