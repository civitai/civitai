import {
  Button,
  Divider,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import dayjs from '~/shared/utils/dayjs';
import { useRouter } from 'next/router';
import React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { BackButton } from '~/components/BackButton/BackButton';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { ModelVersionMultiSelect } from '~/components/Challenge/ModelVersionMultiSelect';
import { ContentRatingSelect } from '~/components/Challenge/ContentRatingSelect';
import { SimpleImageUpload } from '~/libs/form/components/SimpleImageUpload';
import { trpc } from '~/utils/trpc';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { ChallengeSource, ChallengeStatus, Currency } from '~/shared/utils/prisma/enums';
import type { Prize } from '~/server/schema/challenge.schema';

// Cover image type for the form
type CoverImageData = {
  id?: number;
  url: string;
  name?: string;
} | null;

// Form data type (explicit, no zod inference issues)
type ChallengeFormData = {
  title: string;
  description: string;
  theme: string;
  invitation: string;
  coverImage: CoverImageData;
  modelVersionIds: number[]; // Array of allowed model version IDs
  nsfwLevel: number;
  allowedNsfwLevel: number; // Bitwise NSFW levels for entries
  judgingPrompt: string;
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
  prize1Buzz: number;
  prize2Buzz: number;
  prize3Buzz: number;
  entryPrizeBuzz: number;
};

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

  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ChallengeFormData>({
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

  const onSubmit = (data: ChallengeFormData) => {
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
      coverImage: data.coverImage ?? undefined, // Send full image object, server creates Image record if needed
      modelVersionIds: data.modelVersionIds,
      nsfwLevel: data.nsfwLevel,
      allowedNsfwLevel: data.allowedNsfwLevel,
      judgingPrompt: data.judgingPrompt,
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
  const prize1 = watch('prize1Buzz');
  const prize2 = watch('prize2Buzz');
  const prize3 = watch('prize3Buzz');
  const totalPrizePool = (prize1 || 0) + (prize2 || 0) + (prize3 || 0);

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Stack gap="xl">
        {/* Header */}
        <Group>
          <BackButton url="/moderator/challenges" />
          <Title order={2}>{isEditing ? 'Edit Challenge' : 'Create Challenge'}</Title>
        </Group>

        {/* Main Content */}
        <Paper withBorder p="md">
          <Stack gap="md">
            <Title order={4}>Basic Information</Title>

            <TextInput
              label="Title"
              placeholder="Enter challenge title"
              required
              error={errors.title?.message}
              {...register('title')}
            />

            <TextInput
              label="Theme"
              placeholder="1-2 word theme (e.g., 'Neon Dreams')"
              error={errors.theme?.message}
              {...register('theme')}
            />

            <TextInput
              label="Invitation"
              placeholder="Short tagline to invite participants"
              error={errors.invitation?.message}
              {...register('invitation')}
            />

            <Textarea
              label="Description"
              placeholder="Full challenge description (supports markdown)"
              minRows={4}
              error={errors.description?.message}
              {...register('description')}
            />

            <Controller
              name="coverImage"
              control={control}
              render={({ field }) => (
                <SimpleImageUpload
                  label="Cover Image"
                  description="Suggested resolution: 1200 x 630 (optional)"
                  value={field.value ?? undefined}
                  onChange={field.onChange}
                  withNsfwLevel={false}
                />
              )}
            />
          </Stack>
        </Paper>

        {/* Model Version Selection */}
        <Paper withBorder p="md">
          <Controller
            name="modelVersionIds"
            control={control}
            render={({ field }) => (
              <ModelVersionMultiSelect
                value={field.value}
                onChange={field.onChange}
                label="Required Model Versions"
                description="Optionally require specific model versions for entries. Entries must use at least one of these models (OR logic). Leave empty to allow any model."
              />
            )}
          />
        </Paper>

        {/* Timing */}
        <Paper withBorder p="md">
          <Stack gap="md">
            <Title order={4}>Schedule</Title>

            <Group grow>
              <Controller
                name="visibleAt"
                control={control}
                render={({ field }) => (
                  <DateTimePicker
                    label="Visible From"
                    placeholder="When challenge appears in feed"
                    value={field.value}
                    onChange={field.onChange}
                    error={errors.visibleAt?.message}
                  />
                )}
              />

              <Controller
                name="startsAt"
                control={control}
                render={({ field }) => (
                  <DateTimePicker
                    label="Starts At"
                    placeholder="When submissions open"
                    value={field.value}
                    onChange={field.onChange}
                    error={errors.startsAt?.message}
                  />
                )}
              />

              <Controller
                name="endsAt"
                control={control}
                render={({ field }) => (
                  <DateTimePicker
                    label="Ends At"
                    placeholder="When submissions close"
                    value={field.value}
                    onChange={field.onChange}
                    error={errors.endsAt?.message}
                  />
                )}
              />
            </Group>
          </Stack>
        </Paper>

        {/* Prizes */}
        <Paper withBorder p="md">
          <Stack gap="md">
            <Group justify="space-between">
              <Title order={4}>Prizes</Title>
              <CurrencyBadge currency={Currency.BUZZ} unitAmount={totalPrizePool} size="lg" />
            </Group>

            <Group grow>
              <Controller
                name="prize1Buzz"
                control={control}
                render={({ field }) => (
                  <NumberInput
                    label="1st Place (Buzz)"
                    min={0}
                    step={100}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
              <Controller
                name="prize2Buzz"
                control={control}
                render={({ field }) => (
                  <NumberInput
                    label="2nd Place (Buzz)"
                    min={0}
                    step={100}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
              <Controller
                name="prize3Buzz"
                control={control}
                render={({ field }) => (
                  <NumberInput
                    label="3rd Place (Buzz)"
                    min={0}
                    step={100}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
            </Group>

            <Divider />

            <Controller
              name="entryPrizeBuzz"
              control={control}
              render={({ field }) => (
                <NumberInput
                  label="Participation Prize (Buzz per valid entry)"
                  description="Optional buzz reward for all valid entries"
                  min={0}
                  step={10}
                  value={field.value}
                  onChange={field.onChange}
                  style={{ maxWidth: 300 }}
                />
              )}
            />
          </Stack>
        </Paper>

        {/* Entry Requirements */}
        <Paper withBorder p="md">
          <Stack gap="md">
            <Title order={4}>Entry Requirements</Title>

            {/* Content Rating Selection */}
            <Controller
              name="allowedNsfwLevel"
              control={control}
              render={({ field }) => (
                <ContentRatingSelect value={field.value} onChange={field.onChange} />
              )}
            />

            <Divider />

            {/* Entry Limits */}
            <Group grow>
              <Controller
                name="maxEntriesPerUser"
                control={control}
                render={({ field }) => (
                  <NumberInput
                    label="Max Entries Per User"
                    description="Maximum submissions per participant"
                    min={1}
                    max={100}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />

              <Controller
                name="entryPrizeRequirement"
                control={control}
                render={({ field }) => (
                  <NumberInput
                    label="Entry Prize Requirement"
                    description="Min entries to qualify for participation prize"
                    min={1}
                    max={100}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
            </Group>
          </Stack>
        </Paper>

        {/* Configuration */}
        <Paper withBorder p="md">
          <Stack gap="md">
            <Title order={4}>AI Configuration</Title>

            <Group grow>
              <Controller
                name="reviewPercentage"
                control={control}
                render={({ field }) => (
                  <NumberInput
                    label="Review Percentage"
                    description="% of entries to AI-score"
                    min={0}
                    max={100}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />

              <Controller
                name="operationBudget"
                control={control}
                render={({ field }) => (
                  <NumberInput
                    label="Operation Budget (Buzz)"
                    description="Budget for AI review costs"
                    min={0}
                    step={100}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
            </Group>

            <Textarea
              label="Custom Judging Prompt"
              placeholder="Custom prompt for AI judging (leave empty for default)"
              minRows={3}
              {...register('judgingPrompt')}
            />
          </Stack>
        </Paper>

        {/* Status */}
        <Paper withBorder p="md">
          <Stack gap="md">
            <Title order={4}>Status</Title>

            <Group grow>
              <Controller
                name="status"
                control={control}
                render={({ field }) => (
                  <Select
                    label="Challenge Status"
                    data={[
                      { value: ChallengeStatus.Draft, label: 'Draft' },
                      { value: ChallengeStatus.Scheduled, label: 'Scheduled' },
                      { value: ChallengeStatus.Active, label: 'Active' },
                      { value: ChallengeStatus.Judging, label: 'Judging' },
                      { value: ChallengeStatus.Completed, label: 'Completed' },
                      { value: ChallengeStatus.Cancelled, label: 'Cancelled' },
                    ]}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />

              <Controller
                name="source"
                control={control}
                render={({ field }) => (
                  <Select
                    label="Challenge Source"
                    data={[
                      { value: ChallengeSource.System, label: 'System (Auto-generated)' },
                      { value: ChallengeSource.Mod, label: 'Moderator' },
                      { value: ChallengeSource.User, label: 'User' },
                    ]}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
            </Group>
          </Stack>
        </Paper>

        {/* Actions */}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => router.push('/moderator/challenges')}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting || upsertMutation.isPending}>
            {isEditing ? 'Update Challenge' : 'Create Challenge'}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
