import type { SelectProps } from '@mantine/core';
import {
  Alert,
  Button,
  Divider,
  Group,
  Paper,
  Select,
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
import { ChallengeReviewCostType, ChallengeSource, ChallengeStatus, Currency } from '~/shared/utils/prisma/enums';
import { upsertChallengeBaseSchema, type Prize } from '~/server/schema/challenge.schema';
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
  reviewCostType: ChallengeReviewCostType;
  reviewCost: number;
  startsAt: Date;
  endsAt: Date;
  visibleAt: Date;
  status: ChallengeStatus;
  source: ChallengeSource;
  prizes: Prize[];
  entryPrize: Prize | null;
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
      reviewCostType: challenge?.reviewCostType ?? ChallengeReviewCostType.None,
      reviewCost: challenge?.reviewCost ?? 0,
      startsAt: challenge?.startsAt ?? defaultStartsAt,
      endsAt: challenge?.endsAt ?? defaultEndsAt,
      visibleAt: challenge?.visibleAt ?? defaultVisibleAt,
      source: challenge?.source ?? ChallengeSource.Mod,
      prize1Buzz: existingPrizes[0]?.buzz ?? 5000,
      prize2Buzz: existingPrizes[1]?.buzz ?? 2500,
      prize3Buzz: existingPrizes[2]?.buzz ?? 1000,
      entryPrizeBuzz: existingEntryPrize?.buzz ?? 0,
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

    // Build prizes array
    const prizes: Prize[] = [
      { buzz: data.prize1Buzz, points: 150 },
      { buzz: data.prize2Buzz, points: 100 },
      { buzz: data.prize3Buzz, points: 50 },
    ].filter((p) => p.buzz > 0);

    const entryPrize: Prize | null =
      data.entryPrizeBuzz > 0 ? { buzz: data.entryPrizeBuzz, points: 10 } : null;

    // Calculate total prize pool
    const totalPrizePool = prizes.reduce((sum, p) => sum + p.buzz, 0);

    upsertMutation.mutate({
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
      prizePool: totalPrizePool,
      operationBudget: data.operationBudget,
      reviewCostType: data.reviewCostType,
      reviewCost: data.reviewCost,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      visibleAt: data.visibleAt,
      source: data.source,
      prizes,
      entryPrize,
    });
  };

  const reviewCostType = form.watch('reviewCostType') ?? ChallengeReviewCostType.None;

  // Watch prize values for total calculation
  const [prize1, prize2, prize3] = form.watch(['prize1Buzz', 'prize2Buzz', 'prize3Buzz']);
  const totalPrizePool = (prize1 || 0) + (prize2 || 0) + (prize3 || 0);

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

            <Divider />

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

            <Divider />

            {/* Paid Review */}
            <Select
              label="Paid Reviews"
              description="Allow users to pay Buzz to guarantee their entries get judged."
              value={reviewCostType}
              onChange={(val) => {
                const type = (val as ChallengeReviewCostType) ?? ChallengeReviewCostType.None;
                form.setValue('reviewCostType', type);
                if (type === ChallengeReviewCostType.None) {
                  form.setValue('reviewCost', 0);
                }
              }}
              data={[
                { value: ChallengeReviewCostType.None, label: 'None' },
                { value: ChallengeReviewCostType.PerEntry, label: 'Per Entry' },
                { value: ChallengeReviewCostType.Flat, label: 'Flat Rate (all entries)' },
              ]}
              disabled={isTerminal}
            />
            {reviewCostType === ChallengeReviewCostType.PerEntry && (
              <InputNumberWrapper
                name="reviewCost"
                label="Cost Per Entry"
                description="Buzz charged for each entry the user wants reviewed."
                leftSection={<CurrencyIcon currency={Currency.BUZZ} size={16} />}
                currency={Currency.BUZZ}
                min={0}
                step={1}
                disabled={isTerminal}
              />
            )}
            {reviewCostType === ChallengeReviewCostType.Flat && (
              <InputNumberWrapper
                name="reviewCost"
                label="Flat Rate"
                description="One-time Buzz charge to review all of the user's entries."
                leftSection={<CurrencyIcon currency={Currency.BUZZ} size={16} />}
                currency={Currency.BUZZ}
                min={0}
                step={1}
                disabled={isTerminal}
              />
            )}
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
