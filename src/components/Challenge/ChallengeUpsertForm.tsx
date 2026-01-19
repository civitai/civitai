import { Button, Divider, Group, Paper, SimpleGrid, Stack, Title } from '@mantine/core';
import dayjs from '~/shared/utils/dayjs';
import { useRouter } from 'next/router';
import React from 'react';
import * as z from 'zod';
import { BackButton } from '~/components/BackButton/BackButton';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
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
import { withController } from '~/libs/form/hoc/withController';
import { trpc } from '~/utils/trpc';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { ChallengeSource, ChallengeStatus, Currency } from '~/shared/utils/prisma/enums';
import { upsertChallengeSchema, type Prize } from '~/server/schema/challenge.schema';

// Wrapped custom components for form integration
const InputModelVersionMultiSelect = withController(ModelVersionMultiSelect);
const InputContentRatingSelect = withController(ContentRatingSelect);

// Form schema - extends server schema with flattened prize fields for UI
const schema = upsertChallengeSchema.omit({ prizes: true, entryPrize: true }).extend({
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
};

type Props = {
  challenge?: ChallengeForEdit;
};

export function ChallengeUpsertForm({ challenge }: Props) {
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const isEditing = !!challenge;

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
      coverImage: challenge?.coverImage ?? null,
      modelVersionIds: challenge?.modelVersionIds ?? [],
      nsfwLevel: challenge?.nsfwLevel ?? 1,
      allowedNsfwLevel: challenge?.allowedNsfwLevel ?? 1,
      judgingPrompt: challenge?.judgingPrompt ?? '',
      reviewPercentage: challenge?.reviewPercentage ?? 100,
      maxEntriesPerUser: challenge?.maxEntriesPerUser ?? 20,
      entryPrizeRequirement: challenge?.entryPrizeRequirement ?? 10,
      prizePool: challenge?.prizePool ?? 0,
      operationBudget: challenge?.operationBudget ?? 0,
      startsAt: challenge?.startsAt ?? defaultStartsAt,
      endsAt: challenge?.endsAt ?? defaultEndsAt,
      visibleAt: challenge?.visibleAt ?? defaultVisibleAt,
      status: challenge?.status ?? ChallengeStatus.Draft,
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
      judgingPrompt: data.judgingPrompt || undefined,
      reviewPercentage: data.reviewPercentage,
      maxEntriesPerUser: data.maxEntriesPerUser,
      entryPrizeRequirement: data.entryPrizeRequirement,
      prizePool: totalPrizePool,
      operationBudget: data.operationBudget,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      visibleAt: data.visibleAt,
      status: data.status,
      source: data.source,
      prizes,
      entryPrize,
    });
  };

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

        {/* Main Content */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>Basic Information</Title>

            <InputText
              name="title"
              label="Title"
              placeholder="Enter challenge title"
              withAsterisk
            />

            <InputText
              name="theme"
              label="Theme"
              placeholder="1-2 word theme (e.g., 'Neon Dreams')"
            />

            <InputText
              name="invitation"
              label="Invitation"
              placeholder="Short tagline to invite participants"
            />

            <InputRTE
              name="description"
              label="Description"
              description="Full challenge description"
              placeholder="Enter challenge description..."
              includeControls={['heading', 'formatting', 'list', 'link']}
              editorSize="lg"
              stickyToolbar
            />

            <InputSimpleImageUpload
              name="coverImage"
              label="Cover Image"
              description="Suggested resolution: 1200 x 630 (optional)"
              withNsfwLevel={false}
            />
          </Stack>
        </Paper>

        {/* Model Version Selection */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <InputModelVersionMultiSelect
            name="modelVersionIds"
            label="Required Model Versions"
            description="Optionally require specific model versions for entries. Entries must use at least one of these models (OR logic). Leave empty to allow any model."
          />
        </Paper>

        {/* Timing */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>Schedule</Title>

            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <InputDateTimePicker
                name="visibleAt"
                label="Visible From"
                placeholder="When challenge appears in feed"
              />

              <InputDateTimePicker
                name="startsAt"
                label="Starts At"
                placeholder="When submissions open"
              />

              <InputDateTimePicker
                name="endsAt"
                label="Ends At"
                placeholder="When submissions close"
              />
            </SimpleGrid>
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
              <InputNumber name="prize1Buzz" label="1st Place (Buzz)" min={0} step={100} />
              <InputNumber name="prize2Buzz" label="2nd Place (Buzz)" min={0} step={100} />
              <InputNumber name="prize3Buzz" label="3rd Place (Buzz)" min={0} step={100} />
            </SimpleGrid>

            <Divider />

            <InputNumber
              name="entryPrizeBuzz"
              label="Participation Prize (Buzz per valid entry)"
              description="Optional buzz reward for all valid entries"
              min={0}
              step={10}
            />
          </Stack>
        </Paper>

        {/* Entry Requirements */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>Entry Requirements</Title>

            {/* Content Rating Selection */}
            <InputContentRatingSelect name="allowedNsfwLevel" />

            <Divider />

            {/* Entry Limits */}
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <InputNumber
                name="maxEntriesPerUser"
                label="Max Entries Per User"
                description="Maximum submissions per participant"
                min={1}
                max={100}
              />

              <InputNumber
                name="entryPrizeRequirement"
                label="Entry Prize Requirement"
                description="Min entries to qualify for participation prize"
                min={1}
                max={100}
              />
            </SimpleGrid>
          </Stack>
        </Paper>

        {/* Configuration */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>AI Configuration</Title>

            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <InputNumber
                name="reviewPercentage"
                label="Review Percentage"
                description="% of entries to AI-score"
                min={0}
                max={100}
              />

              <InputNumber
                name="operationBudget"
                label="Operation Budget (Buzz)"
                description="Budget for AI review costs"
                min={0}
                step={100}
              />
            </SimpleGrid>

            <InputTextArea
              name="judgingPrompt"
              label="Custom Judging Prompt"
              placeholder="Custom prompt for AI judging (leave empty for default)"
              minRows={3}
            />
          </Stack>
        </Paper>

        {/* Status */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>Status</Title>

            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <InputSelect
                name="status"
                label="Challenge Status"
                data={[
                  { value: ChallengeStatus.Draft, label: 'Draft' },
                  { value: ChallengeStatus.Scheduled, label: 'Scheduled' },
                  { value: ChallengeStatus.Active, label: 'Active' },
                  { value: ChallengeStatus.Judging, label: 'Judging' },
                  { value: ChallengeStatus.Completed, label: 'Completed' },
                  { value: ChallengeStatus.Cancelled, label: 'Cancelled' },
                ]}
              />

              <InputSelect
                name="source"
                label="Challenge Source"
                data={[
                  { value: ChallengeSource.System, label: 'System (Auto-generated)' },
                  { value: ChallengeSource.Mod, label: 'Moderator' },
                  { value: ChallengeSource.User, label: 'User' },
                ]}
              />
            </SimpleGrid>
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
