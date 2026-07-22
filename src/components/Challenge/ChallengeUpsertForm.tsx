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
  Switch,
  Text,
  Title,
} from '@mantine/core';
import dayjs from '~/shared/utils/dayjs';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import * as z from 'zod';
import { BackButton } from '~/components/BackButton/BackButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { ModelVersionMultiSelect } from '~/components/Challenge/ModelVersionMultiSelect';
import { ContentRatingSelect } from '~/components/Challenge/ContentRatingSelect';
import {
  Form,
  InputDateTimePicker,
  InputNumber,
  InputRTE,
  InputSegmentedControl,
  InputSelect,
  InputSimpleImageUpload,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { withController } from '~/libs/form/hoc/withController';
import { toDisplayUTC, fromDisplayUTC } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import {
  ChallengeReviewCostType,
  ChallengeSource,
  ChallengeStatus,
  Currency,
  PrizeMode,
  PoolTrigger,
} from '~/shared/utils/prisma/enums';
import {
  challengeJudgingCategoryInputSchema,
  challengeJudgingCategoriesInputSchema,
  upsertChallengeBaseSchema,
  type ChallengeJudgingCategoryInput,
  type Prize,
} from '~/server/schema/challenge.schema';
import { computeDynamicPool } from '~/server/games/daily-challenge/challenge-pool';
import { IconCheck, IconInfoCircle } from '@tabler/icons-react';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import CategoryWeights from '~/components/Challenge/CategoryWeights';
import {
  type CategoryWeightRow,
  CHALLENGE_ENTRY_HOUSE_CUT,
  CHALLENGE_MAX_DURATION_DAYS,
  CHALLENGE_MAX_DURATION_MS,
  CHALLENGE_MAX_ENTRY_FEE,
  CHALLENGE_MAX_INITIAL_PRIZE,
  CHALLENGE_MAX_START_LEAD_DAYS,
  CHALLENGE_MIN_DURATION_HOURS,
  CHALLENGE_MIN_DURATION_MS,
  CHALLENGE_MIN_ENTRY_FEE,
  CHALLENGE_MIN_START_LEAD_HOURS,
  DEFAULT_CATEGORY_ROWS,
  getEntryPoolContribution,
  getMaxUserChallengeStartsAt,
  getMinUserChallengeStartsAt,
  getUserChallengeVisibleAt,
} from '~/shared/constants/challenge.constants';

// Wrapped custom components for form integration
const InputModelVersionMultiSelect = withController(ModelVersionMultiSelect);
const InputContentRatingSelect = withController(ContentRatingSelect);

// Form schema - extends server schema with flattened prize fields for UI
// judgeId is overridden to string|null because Mantine Select uses string values
// Note: cannot use .refine() here because useForm casts schema to ZodObject to access .shape
const schema = upsertChallengeBaseSchema
  .omit({ prizes: true, entryPrize: true, judgeId: true, eventId: true, themeElements: true })
  .extend({
    // Override with explicit messages — the default zod copy ("Invalid input") doesn't tell the
    // creator what's actually wrong.
    title: z
      .string()
      .min(3, 'Title must be at least 3 characters')
      .max(200, 'Title must be under 200 characters'),
    theme: z.string().min(1, 'Theme is required'),
    themeElements: z.string().optional(),
    judgeId: z.string().nullish().default('1'),
    eventId: z.string().nullish().default(null),
    // The `{ error }` on the object (not just the refine) is what surfaces the message when the
    // field is `undefined` — an undefined object fails the object check before `.refine()` runs.
    coverImage: z
      .object(
        {
          id: z.number().optional(),
          url: z.string(),
          hash: z.string().nullish(),
          width: z.number().nullish(),
          height: z.number().nullish(),
        },
        { error: 'Cover image is required' }
      )
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
    // Optional here: the user variant hides this input (server forces visibleAt on scan-pass) and
    // `shouldUnregister` drops the unmounted field — a required z.date() would fail user submits.
    visibleAt: z.date().optional(),
    // User-variant-only fields (unused by the moderator submit path)
    entryFee: z.number().int().min(CHALLENGE_MIN_ENTRY_FEE).max(CHALLENGE_MAX_ENTRY_FEE).default(CHALLENGE_MIN_ENTRY_FEE),
    initialPrizeBuzz: z.number().int().min(0).max(CHALLENGE_MAX_INITIAL_PRIZE).default(0),
    maxParticipants: z.number().int().min(1).max(100_000).optional(),
    buzzType: z.enum(['green', 'yellow']).default('yellow'),
    // Only key + weight are form state (CategoryWeights derives label/criteria for display; the
    // server re-derives them). `shouldUnregister` strips the rest, so validate the input shape.
    judgingCategories: z.array(challengeJudgingCategoryInputSchema).default([]),
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
  buzzType: 'green' | 'yellow';
  prizes: Prize[];
  entryPrize: Prize | null;
  prizeMode: PrizeMode;
  basePrizePool: number;
  buzzPerAction: number;
  poolTrigger: PoolTrigger | null;
  maxPrizePool: number | null;
  prizeDistribution: number[] | null;
  themeElements: string[] | null;
  judgingCategories?: CategoryWeightRow[];
  entryFee?: number;
  initialPrizeBuzz?: number;
  maxParticipants?: number | null;
};

type Props = {
  challenge?: ChallengeForEdit;
  variant?: 'moderator' | 'user';
};

// D6-seed: the mod "Customize judging categories" toggle starts ON whenever categories already
// exist (or the challenge is new) and OFF when a mod opens an existing null-category challenge —
// so saving an unrelated field never silently converts it onto the custom rubric.
export function resolveInitialCustomizeCategories(params: {
  isUser: boolean;
  isEditing: boolean;
  existingCategories?: CategoryWeightRow[] | null;
}) {
  const { isUser, isEditing, existingCategories } = params;
  return isUser || !isEditing || !!existingCategories?.length;
}

export type ModJudgingCategoriesResult =
  | { success: true; data: ChallengeJudgingCategoryInput[] | null }
  | { success: false; message: string };

// Off -> explicit null (Task 5 persists Prisma.JsonNull) and the sum-100 validation is skipped
// entirely, so toggling off (or leaving off) never blocks submit on stale/empty category rows.
export function resolveModJudgingCategoriesSubmission(
  customizeCategories: boolean,
  categories: ChallengeJudgingCategoryInput[]
): ModJudgingCategoriesResult {
  if (!customizeCategories) return { success: true, data: null };
  const result = challengeJudgingCategoriesInputSchema.safeParse(categories);
  if (!result.success) {
    return { success: false, message: result.error.issues[0]?.message ?? 'Invalid judging categories' };
  }
  return { success: true, data: result.data };
}

export function ChallengeUpsertForm({ challenge, variant = 'moderator' }: Props) {
  const isUser = variant === 'user';
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const isEditing = !!challenge;
  const isActive = challenge?.status === ChallengeStatus.Active;
  const isTerminal =
    challenge?.status === ChallengeStatus.Completing ||
    challenge?.status === ChallengeStatus.Completed ||
    challenge?.status === ChallengeStatus.Cancelled;

  const [domainBuzzType] = useAvailableBuzz();
  // buzzType is immutable, and a creator can edit cross-domain, so the current domain wouldn't
  // reflect the challenge's real currency — prefer the stored value when editing.
  const effectiveBuzzType = isEditing ? challenge?.buzzType : domainBuzzType;

  // Mod-only "Customize judging categories" toggle. Presentation/submission-only state — it isn't
  // part of the submitted schema, so it lives outside RHF rather than as a form field.
  const [customizeCategories, setCustomizeCategories] = useState(() =>
    resolveInitialCustomizeCategories({
      isUser,
      isEditing,
      existingCategories: challenge?.judgingCategories,
    })
  );

  // One judges endpoint for both variants — the server returns the full list (with sensitive fields)
  // to moderators and the public, SFW-selectable subset to everyone else.
  const { data: judges = [] } = trpc.challenge.getJudges.useQuery();
  const { data: events = [] } = trpc.challenge.getEvents.useQuery(
    { activeOnly: false },
    { enabled: !isUser }
  );

  // Schedule timezone display mode. Default local for everyone; mods can toggle to UTC.
  const [scheduleTz, setScheduleTz] = useState<'local' | 'utc'>('local');
  const isUtcSchedule = scheduleTz === 'utc';
  const toScheduleDisplay = (d: Date) => (isUtcSchedule ? toDisplayUTC(d) : d);
  const fromScheduleDisplay = (d: Date) => (isUtcSchedule ? fromDisplayUTC(d) : d);
  const snapScheduleHour = (d: Date) =>
    (isUtcSchedule ? dayjs.utc(fromDisplayUTC(d)) : dayjs(d)).startOf('hour').toDate();

  // Default dates as local start-of-day instants (rendered in the active schedule tz).
  const defaultStartsAt = dayjs().add(1, 'day').startOf('day').toDate();
  const defaultEndsAt = dayjs().add(2, 'day').startOf('day').toDate();
  const defaultVisibleAt = dayjs().startOf('day').toDate();

  // Parse existing prizes
  const existingPrizes = challenge?.prizes ?? [];
  const existingEntryPrize = challenge?.entryPrize;

  // Description + judge are required for the user variant only. Enforcing them in the schema (not
  // just in handleSubmit) makes their errors surface inline on the first submit, alongside
  // title/theme/cover — otherwise the manual checks never run because zod short-circuits.
  const formSchema = useMemo(
    () =>
      isUser
        ? // cast: extend only tightens description/judgeId (both read via `.shape` by useForm), so
          // the base type keeps defaultValues/handleSubmit typing identical across variants.
          (schema.extend({
            description: z
              .string()
              .min(1, 'Description is required')
              .max(5000, 'Description must be under 5000 characters'),
            judgeId: z.string().min(1, 'Select a judge for your challenge'),
          }) as unknown as typeof schema)
        : schema,
    [isUser]
  );

  const form = useForm({
    schema: formSchema,
    defaultValues: {
      title: challenge?.title ?? '',
      description: challenge?.description ?? '',
      theme: challenge?.theme ?? '',
      themeElements: challenge?.themeElements?.join(', ') ?? '',
      invitation: challenge?.invitation ?? '',
      coverImage: challenge?.coverImage ?? undefined,
      modelVersionIds: challenge?.modelVersionIds ?? [],
      nsfwLevel: challenge?.nsfwLevel ?? 1,
      allowedNsfwLevel: challenge?.allowedNsfwLevel ?? sfwBrowsingLevelsFlag,
      buzzType: challenge?.buzzType ?? (domainBuzzType === 'green' ? 'green' : 'yellow'),
      judgeId: challenge?.judgeId ? String(challenge.judgeId) : isUser ? '' : '1',
      eventId: challenge?.eventId ? String(challenge.eventId) : null,
      judgingPrompt: challenge?.judgingPrompt ?? '',
      reviewPercentage: challenge?.reviewPercentage ?? 100,
      maxEntriesPerUser: challenge?.maxEntriesPerUser ?? (isUser ? 5 : 20),
      entryPrizeRequirement: challenge?.entryPrizeRequirement ?? 10,
      prizePool: challenge?.prizePool ?? 0,
      operationBudget: challenge?.operationBudget ?? 0,
      reviewCostType: challenge?.reviewCostType ?? ChallengeReviewCostType.None,
      reviewCost: challenge?.reviewCost ?? 0,
      startsAt: challenge?.startsAt ? toScheduleDisplay(challenge.startsAt) : defaultStartsAt,
      endsAt: challenge?.endsAt ? toScheduleDisplay(challenge.endsAt) : defaultEndsAt,
      visibleAt: challenge?.visibleAt ? toScheduleDisplay(challenge.visibleAt) : defaultVisibleAt,
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
      // `||` (not `??`): non-entry-fee challenges store entryFee 0, which would fail the min-fee
      // schema check if used as a default.
      entryFee: challenge?.entryFee || CHALLENGE_MIN_ENTRY_FEE,
      initialPrizeBuzz: challenge?.initialPrizeBuzz ?? 0,
      maxParticipants: challenge?.maxParticipants ?? undefined,
      // User variant + new mod challenges seed defaults immediately; a mod editing an existing
      // null-category challenge starts empty — CategoryWeights is hidden (toggle off) until the
      // mod opts in, at which point it's seeded on demand (see handleCustomizeCategoriesChange).
      judgingCategories:
        challenge?.judgingCategories ?? (isUser || !isEditing ? DEFAULT_CATEGORY_ROWS : []),
    },
  });

  const upsertMutation = trpc.challenge.upsert.useMutation({
    onSuccess: (result) => {
      queryUtils.challenge.getModeratorList.invalidate();
      queryUtils.challenge.getById.invalidate({ id: result.id });
      queryUtils.challenge.getForEdit.invalidate({ id: result.id });
      showSuccessNotification({
        message: isEditing ? 'Challenge updated successfully' : 'Challenge created successfully',
      });
      router.push('/moderator/challenges');
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const upsertUserMutation = trpc.challenge.upsertUserChallenge.useMutation({
    onSuccess: async (result) => {
      showSuccessNotification({
        title: 'Challenge submitted',
        message: 'Your challenge is being reviewed and will go live once it passes moderation.',
      });
      await queryUtils.challenge.getInfinite.invalidate();
      await queryUtils.challenge.getUserChallengeForEdit.invalidate({ id: result.id });
      await router.push(`/challenges/${result.id}`);
    },
    onError: (error) => {
      showErrorNotification({ title: 'Unable to create challenge', error: new Error(error.message) });
    },
  });

  // Seed on demand when a mod opts into customizing: an empty array is a broken editor state
  // (CategoryWeights requires an always-present locked `theme` row), so only seed if not already
  // populated — never overwrite categories the mod already has.
  const handleCustomizeCategoriesChange = (checked: boolean) => {
    setCustomizeCategories(checked);
    if (checked && (form.getValues('judgingCategories')?.length ?? 0) === 0) {
      form.setValue('judgingCategories', DEFAULT_CATEGORY_ROWS);
    }
  };

  const handleSubmit = (data: z.infer<typeof schema>) => {
    // Snap to exact hours and resolve to the true UTC instant (honoring the schedule tz mode)
    const startsAt = snapScheduleHour(data.startsAt);
    const endsAt = snapScheduleHour(data.endsAt);

    // Cross-field date validation (can't use .refine() because useForm accesses .shape)
    if (endsAt <= startsAt) {
      form.setError('endsAt', { message: 'End date must be after start date' });
      return;
    }

    const parsedThemeElements = data.themeElements
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (isUser) {
      // The user schema requires description (see formSchema) — this narrows the type for the
      // mutation and is a safety net; the inline error comes from the schema on the first submit.
      if (!data.description) {
        form.setError('description', { message: 'Description is required' });
        return;
      }

      // Duration bounds mirror the server (and zod schema): intrinsic to the payload, so they
      // apply on create and edit alike.
      const durationMs = endsAt.getTime() - startsAt.getTime();
      if (durationMs < CHALLENGE_MIN_DURATION_MS) {
        form.setError('endsAt', {
          message: `Challenge must run for at least ${CHALLENGE_MIN_DURATION_HOURS} hours.`,
        });
        return;
      }
      if (durationMs > CHALLENGE_MAX_DURATION_MS) {
        form.setError('endsAt', {
          message: `Challenge cannot run longer than ${CHALLENGE_MAX_DURATION_DAYS} days.`,
        });
        return;
      }

      // Start must be >= 3h and <= 30d out. Mirrors the server: always on create, on edit only
      // when the start date actually moved (so an unrelated edit near start time isn't blocked).
      const startMoved = !challenge || startsAt.getTime() !== challenge.startsAt.getTime();
      if (startMoved && startsAt < getMinUserChallengeStartsAt()) {
        form.setError('startsAt', {
          message: `Challenge must start at least ${CHALLENGE_MIN_START_LEAD_HOURS} hours from now.`,
        });
        return;
      }
      if (startMoved && startsAt > getMaxUserChallengeStartsAt()) {
        form.setError('startsAt', {
          message: `Challenge cannot start more than ${CHALLENGE_MAX_START_LEAD_DAYS} days from now.`,
        });
        return;
      }

      // Validate distribution sums to 100 (mirrors the mod Dynamic-mode check below)
      const distTotal = (data.dist1 ?? 0) + (data.dist2 ?? 0) + (data.dist3 ?? 0);
      if (distTotal !== 100) {
        form.setError('dist1', { message: 'Distribution must sum to 100%' });
        return;
      }

      // Backstop: formSchema already requires judgeId for the user variant (inline error on submit).
      if (!data.judgeId) {
        form.setError('judgeId', { message: 'Select a judge for your challenge' });
        return;
      }

      const categoriesResult = challengeJudgingCategoriesInputSchema.safeParse(data.judgingCategories);
      if (!categoriesResult.success) {
        showErrorNotification({
          title: 'Invalid judging categories',
          error: new Error(categoriesResult.error.issues[0]?.message ?? 'Invalid judging categories'),
        });
        return;
      }

      upsertUserMutation.mutate({
        id: challenge?.id,
        title: data.title,
        description: data.description,
        theme: data.theme,
        themeElements: parsedThemeElements?.length ? parsedThemeElements : undefined,
        coverImage: data.coverImage,
        allowedNsfwLevel: data.allowedNsfwLevel,
        modelVersionIds: data.modelVersionIds,
        judgeId: Number(data.judgeId),
        judgingCategories: data.judgingCategories,
        entryFee: data.entryFee,
        initialPrizeBuzz: data.initialPrizeBuzz,
        buzzType: data.buzzType,
        prizeDistribution: [data.dist1, data.dist2, data.dist3],
        maxParticipants: data.maxParticipants,
        maxEntriesPerUser: data.maxEntriesPerUser,
        startsAt,
        endsAt,
      });
      return;
    }

    const judgingCategoriesResult = resolveModJudgingCategoriesSubmission(
      customizeCategories,
      data.judgingCategories
    );
    if (!judgingCategoriesResult.success) {
      showErrorNotification({
        title: 'Invalid judging categories',
        error: new Error(judgingCategoriesResult.message),
      });
      return;
    }

    // visibleAt is mod-only (the user variant hides it — server forces it). The picker is always
    // rendered + defaulted here, so this guard is a type-narrowing safety net, not a real path.
    if (!data.visibleAt) {
      form.setError('visibleAt', { message: 'Visible date is required' });
      return;
    }
    const visibleAt = snapScheduleHour(data.visibleAt);

    // Shared fields for both modes
    const sharedFields = {
      id: challenge?.id,
      title: data.title,
      description: data.description || undefined,
      theme: data.theme,
      themeElements: parsedThemeElements?.length ? parsedThemeElements : undefined,
      invitation: data.invitation || undefined,
      coverImage: data.coverImage ?? undefined,
      modelVersionIds: data.modelVersionIds,
      nsfwLevel: data.nsfwLevel,
      allowedNsfwLevel: data.allowedNsfwLevel,
      judgeId: data.judgeId ? Number(data.judgeId) : null,
      eventId: data.eventId ? Number(data.eventId) : null,
      judgingPrompt: data.judgingPrompt || undefined,
      judgingCategories: judgingCategoriesResult.data,
      reviewPercentage: data.reviewPercentage,
      maxEntriesPerUser: data.maxEntriesPerUser,
      entryPrizeRequirement: data.entryPrizeRequirement,
      operationBudget: data.operationBudget,
      reviewCostType: data.reviewCostType,
      reviewCost: data.reviewCost,
      startsAt,
      endsAt,
      visibleAt,
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

  const reviewCostType = form.watch('reviewCostType') ?? ChallengeReviewCostType.None;

  // User-variant entry-fee pool preview
  const entryFeeWatch = form.watch('entryFee') ?? CHALLENGE_MIN_ENTRY_FEE;
  const perEntryToPool = getEntryPoolContribution(entryFeeWatch);
  const selectedBuzzType: 'green' | 'yellow' =
    (form.watch('buzzType') as 'green' | 'yellow' | undefined) ??
    (effectiveBuzzType === 'green' ? 'green' : 'yellow');
  const buzzLabel = selectedBuzzType === 'green' ? 'Green' : 'Yellow';

  // User-variant feed-visibility preview (start - 7d). The watched value is in the active schedule
  // tz, so resolve to the real instant for the future check and re-apply the tz for the label.
  const startsAtWatch = form.watch('startsAt');
  const visibleAtPreview =
    isUser && startsAtWatch ? getUserChallengeVisibleAt(fromScheduleDisplay(startsAtWatch)) : null;
  const visibleAtInFuture = !!visibleAtPreview && visibleAtPreview.getTime() > Date.now();
  const visibleAtLabel = visibleAtPreview
    ? dayjs(toScheduleDisplay(visibleAtPreview)).format('MMM D, YYYY h:mm A')
    : '';

  // Watch prize values for total calculation
  const [prize1, prize2, prize3] = form.watch(['prize1Buzz', 'prize2Buzz', 'prize3Buzz']);
  const prizeMode = form.watch('prizeMode') ?? PrizeMode.Fixed;
  const [dist1, dist2, dist3] = form.watch(['dist1', 'dist2', 'dist3']);
  const basePrizePool = form.watch('basePrizePool') ?? 0;
  const maxPrizePool = form.watch('maxPrizePool');
  const totalPct = (dist1 || 0) + (dist2 || 0) + (dist3 || 0);
  // For Dynamic mode: show max pool if set (assume we'll hit it), otherwise base
  const dynamicDisplayPool =
    maxPrizePool != null && maxPrizePool > 0 ? maxPrizePool : basePrizePool;
  const totalPrizePool =
    prizeMode === PrizeMode.Dynamic
      ? dynamicDisplayPool
      : (prize1 || 0) + (prize2 || 0) + (prize3 || 0);

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack gap="md">
        {/* Header */}
        <Group wrap="wrap">
          <BackButton url={isUser ? '/challenges' : '/moderator/challenges'} />
          <Title order={2} size="h3" className="sm:text-2xl">
            {isEditing ? 'Edit Challenge' : isUser ? 'Create a Challenge' : 'Create Challenge'}
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
                  withAsterisk
                  disabled={isTerminal}
                />

                <InputTextArea
                  name="themeElements"
                  label="Theme Elements"
                  description="Comma-separated visual cues for scoring. Leave empty to auto-generate from theme."
                  placeholder="fluffy white textures, soft rounded shapes, pastel palette, ..."
                  autosize
                  minRows={2}
                  maxRows={4}
                  disabled={isTerminal}
                />

                {!isUser && (
                  <InputText
                    name="invitation"
                    label="Invitation"
                    placeholder="Short tagline to invite participants"
                    disabled={isTerminal}
                  />
                )}
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
              withAsterisk={isUser}
              stickyToolbar
              disabled={isTerminal}
            />
          </Stack>
        </Paper>

        {/* Eligible Models — optional for both variants (empty = any model allowed) */}
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
            <Group justify="space-between" align="center">
              <Title order={4}>Schedule</Title>
              {!isUser && (
                <SegmentedControl
                  size="xs"
                  value={scheduleTz}
                  onChange={(next) => {
                    const val = next as 'local' | 'utc';
                    (['visibleAt', 'startsAt', 'endsAt'] as const).forEach((field) => {
                      const cur = form.getValues(field) as Date | null | undefined;
                      if (!cur) return;
                      const instant = scheduleTz === 'utc' ? fromDisplayUTC(cur) : cur;
                      form.setValue(field, val === 'utc' ? toDisplayUTC(instant) : instant);
                    });
                    setScheduleTz(val);
                  }}
                  data={[
                    { label: 'Local', value: 'local' },
                    { label: 'UTC', value: 'utc' },
                  ]}
                />
              )}
            </Group>
            <Text size="sm" c="dimmed">
              Times are rounded down to the hour ({isUtcSchedule ? 'UTC' : 'your local time'}).
            </Text>

            <SimpleGrid cols={{ base: 1, sm: isUser ? 2 : 3 }}>
              {/* User challenges become visible when the moderation scan passes — server forces visibleAt */}
              {!isUser && (
                <InputDateTimePicker
                  name="visibleAt"
                  label={`Visible From (${isUtcSchedule ? 'UTC' : 'local'})`}
                  placeholder="When challenge appears in feed"
                  valueFormat="lll"
                  withAsterisk
                  disabled={isTerminal}
                  timeInputProps={{ step: 3600 }}
                />
              )}

              <InputDateTimePicker
                name="startsAt"
                label={`Starts At (${isUtcSchedule ? 'UTC' : 'local'})`}
                placeholder="When submissions open"
                valueFormat="lll"
                withAsterisk
                disabled={isActive || isTerminal}
                timeInputProps={{ step: 3600 }}
              />

              <InputDateTimePicker
                name="endsAt"
                label={`Ends At (${isUtcSchedule ? 'UTC' : 'local'})`}
                placeholder="When submissions close"
                valueFormat="lll"
                withAsterisk
                disabled={isTerminal}
                timeInputProps={{ step: 3600 }}
              />
            </SimpleGrid>

            {isUser && (
              <Stack gap={4}>
                <Text size="sm" c="dimmed">
                  {visibleAtInFuture
                    ? `Your challenge appears in the feed from ${visibleAtLabel} (${
                        isUtcSchedule ? 'UTC' : 'local time'
                      }) — one week before it starts.`
                    : 'Your challenge appears in the feed as soon as it passes review.'}
                </Text>
                <Text size="sm" c="dimmed">
                  A moderation scan runs before your challenge becomes visible.
                </Text>
              </Stack>
            )}
          </Stack>
        </Paper>

        {/* Prizes: moderator gets Fixed/Dynamic prize pools; user is entry-fee-funded only */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            {isUser && (
              <>
                <Title order={4}>Entry Fee &amp; Prizes</Title>
                <Stack gap={4}>
                  <InputSegmentedControl
                    name="buzzType"
                    disabled={isActive || isTerminal}
                    onChange={(value) => {
                      if (value === 'green')
                        form.setValue('allowedNsfwLevel', sfwBrowsingLevelsFlag);
                    }}
                    data={[
                      {
                        value: 'yellow',
                        label: (
                          <Group gap={6} justify="center" wrap="nowrap">
                            <CurrencyIcon currency="BUZZ" type="yellow" size={16} />
                            <span>Yellow Buzz</span>
                          </Group>
                        ),
                      },
                      {
                        value: 'green',
                        label: (
                          <Group gap={6} justify="center" wrap="nowrap">
                            <CurrencyIcon currency="BUZZ" type="green" size={16} />
                            <span>Green Buzz</span>
                          </Group>
                        ),
                      },
                    ]}
                  />
                  <Text size="xs" c="dimmed">
                    Green Buzz challenges are Safe-For-Work (PG / PG-13) and run on civitai.com;
                    Yellow Buzz challenges run on civitai.red. Editable while scheduled.
                  </Text>
                </Stack>
                <Alert icon={<IconInfoCircle size={16} />} color="blue">
                  Entry fees &amp; prizes use <b>{buzzLabel} Buzz</b>. Your challenge is funded by
                  entry fees — each entry pays the entry fee; {CHALLENGE_ENTRY_HOUSE_CUT} Buzz per
                  entry covers AI judging and the rest grows the prize pool. Entry fees are
                  non-refundable once paid.
                </Alert>
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <InputNumber
                    name="entryFee"
                    label="Entry Fee"
                    leftSection={<CurrencyIcon currency="BUZZ" type={selectedBuzzType} size={16} />}
                    currency={Currency.BUZZ}
                    min={CHALLENGE_MIN_ENTRY_FEE}
                    max={CHALLENGE_MAX_ENTRY_FEE}
                    step={10}
                    allowNegative={false}
                    clampBehavior="blur"
                    description={`Min ${CHALLENGE_MIN_ENTRY_FEE} Buzz. ${perEntryToPool} Buzz of each entry goes to the prize pool.`}
                    withAsterisk
                    disabled={isTerminal}
                  />
                  <InputNumber
                    name="initialPrizeBuzz"
                    label="Initial Prize (optional)"
                    leftSection={<CurrencyIcon currency="BUZZ" type={selectedBuzzType} size={16} />}
                    currency={Currency.BUZZ}
                    min={0}
                    max={CHALLENGE_MAX_INITIAL_PRIZE}
                    step={100}
                    allowNegative={false}
                    clampBehavior="blur"
                    description="Buzz you seed the pool with (charged to you on creation)."
                    disabled={isTerminal}
                  />
                </SimpleGrid>
                <Divider label="Prize split (must total 100%)" />
                <SimpleGrid cols={3}>
                  <InputNumber 
                    name="dist1"
                    label="1st Place %"
                    min={1}
                    max={100}
                    allowNegative={false}
                    clampBehavior="blur"
                    withAsterisk
                    disabled={isTerminal}
                  />
                  <InputNumber
                    name="dist2"
                    label="2nd Place %"
                    min={1}
                    max={100}
                    allowNegative={false}
                    clampBehavior="blur"
                    withAsterisk
                    disabled={isTerminal}
                  />
                  <InputNumber
                    name="dist3"
                    label="3rd Place %"
                    min={1}
                    max={100}
                    allowNegative={false}
                    clampBehavior="blur"
                    withAsterisk
                    disabled={isTerminal}
                  />
                </SimpleGrid>
                <Text size="sm" c={totalPct === 100 ? 'teal' : 'red'}>
                  {dist1 || 0} + {dist2 || 0} + {dist3 || 0} = {totalPct}%
                  {totalPct === 100 ? ' ✓' : ' (must equal 100%)'}
                </Text>
              </>
            )}

            {!isUser && (
              <>
            <Group justify="space-between" wrap="wrap">
              <Title order={4}>Prizes</Title>
              <CurrencyBadge
                currency={Currency.BUZZ}
                type={selectedBuzzType}
                unitAmount={totalPrizePool}
                size="lg"
              />
            </Group>

            {/* Prize Mode Toggle */}
            <InputSegmentedControl
              name="prizeMode"
              data={[
                { label: 'Fixed Prizes', value: PrizeMode.Fixed },
                { label: 'Dynamic Pool', value: PrizeMode.Dynamic },
              ]}
              disabled={isActive || isTerminal}
            />

            <div className={prizeMode === PrizeMode.Fixed ? '' : 'hidden'}>
              <SimpleGrid cols={{ base: 1, xs: 3 }}>
                <InputNumber
                  name="prize1Buzz"
                  label="1st Place"
                  leftSection={<CurrencyIcon currency="BUZZ" type={selectedBuzzType} size={16} />}
                  currency={Currency.BUZZ}
                  min={0}
                  step={100}
                  disabled={isTerminal}
                />
                <InputNumber
                  name="prize2Buzz"
                  label="2nd Place"
                  leftSection={<CurrencyIcon currency="BUZZ" type={selectedBuzzType} size={16} />}
                  currency={Currency.BUZZ}
                  min={0}
                  step={100}
                  disabled={isTerminal}
                />
                <InputNumber
                  name="prize3Buzz"
                  label="3rd Place"
                  leftSection={<CurrencyIcon currency="BUZZ" type={selectedBuzzType} size={16} />}
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
                <InputNumber
                  name="basePrizePool"
                  label="Base Prize Pool"
                  leftSection={<CurrencyIcon currency="BUZZ" type={selectedBuzzType} size={16} />}
                  currency={Currency.BUZZ}
                  min={0}
                  step={100}
                  disabled={isActive || isTerminal}
                />

                {/* Growth Rule */}
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <InputNumber
                    name="buzzPerAction"
                    label="Buzz Per Trigger"
                    leftSection={<CurrencyIcon currency="BUZZ" type={selectedBuzzType} size={16} />}
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
                <InputNumber
                  name="maxPrizePool"
                  label="Max Prize Pool (optional)"
                  description="Leave empty for unlimited growth"
                  leftSection={<CurrencyIcon currency="BUZZ" type={selectedBuzzType} size={16} />}
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
                    min={1}
                    max={100}
                    allowNegative={false}
                    clampBehavior="blur"
                    disabled={isActive || isTerminal}
                  />
                  <InputNumber
                    name="dist2"
                    label="2nd Place %"
                    min={1}
                    max={100}
                    allowNegative={false}
                    clampBehavior="blur"
                    disabled={isActive || isTerminal}
                  />
                  <InputNumber
                    name="dist3"
                    label="3rd Place %"
                    min={1}
                    max={100}
                    allowNegative={false}
                    clampBehavior="blur"
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
                      1st: {Math.floor((dynamicDisplayPool * (dist1 || 0)) / 100).toLocaleString()}
                      {' / '}2nd:{' '}
                      {Math.floor((dynamicDisplayPool * (dist2 || 0)) / 100).toLocaleString()}
                      {' / '}3rd:{' '}
                      {Math.floor((dynamicDisplayPool * (dist3 || 0)) / 100).toLocaleString()}
                      {' buzz'}
                    </Text>
                  )}
                </Group>
              </Stack>
            </div>

            <Divider />

            {/* Participation Prize - both modes */}
            <InputNumber
              name="entryPrizeBuzz"
              label="Participation Prize (per valid entry)"
              description="Optional buzz reward for all valid entries"
              leftSection={<CurrencyIcon currency="BUZZ" type="blue" size={16} />}
              currency={Currency.BUZZ}
              min={0}
              step={10}
              disabled={isTerminal}
            />
              </>
            )}
          </Stack>
        </Paper>

        {/* Entry Requirements */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>Entry Requirements</Title>

            {/* Content Rating Selection — creator picks the browsing level; defaults to SFW */}
            <InputContentRatingSelect
              name="allowedNsfwLevel"
              disabled={isActive || isTerminal}
              sfwOnly={selectedBuzzType === 'green'}
            />
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

              {!isUser && (
                <InputNumber
                  name="entryPrizeRequirement"
                  label="Entry Prize Requirement"
                  description="Min entries to qualify for participation prize"
                  min={1}
                  max={100}
                  disabled={isActive || isTerminal}
                />
              )}

              {isUser && (
                <InputNumber
                  name="maxParticipants"
                  label="Max Participants (optional)"
                  description="Once reached, no new participants can join."
                  min={1}
                  max={100_000}
                  disabled={isActive || isTerminal}
                />
              )}
            </SimpleGrid>

            {/* Paid Review (moderator-only; user challenges have no per-entry review cost) */}
            {!isUser && (
              <>
                <Divider />
                <InputSelect
                  label="Paid Reviews"
                  name="reviewCostType"
                  description="Allow users to pay Buzz to guarantee their entries get judged."
                  onChange={(val) => {
                    const type = (val as ChallengeReviewCostType) ?? ChallengeReviewCostType.None;
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
              </>
            )}
            {!isUser && reviewCostType === ChallengeReviewCostType.PerEntry && (
              <InputNumber
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
            {!isUser && reviewCostType === ChallengeReviewCostType.Flat && (
              <InputNumber
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

        {/* Judging: judge persona + (user) weighted categories in one card */}
        <Paper withBorder p={{ base: 'sm', sm: 'md' }}>
          <Stack gap="md">
            <Title order={4}>Judging</Title>
            <InputSelect
              classNames={{ option: '[&[data-checked="true"]]:bg-blue-9/30' }}
              name="judgeId"
              label="Assigned Judge"
              placeholder="Select a judge persona"
              description={
                isUser
                  ? 'Select the AI judge for this challenge.'
                  : 'Select a judge persona for this challenge. Leave empty for default judging.'
              }
              data={judges.map((j) => ({ value: String(j.id), label: j.name }))}
              renderOption={(item) => renderJudgeOption({ ...item, judges: judges })}
              onChange={(value) => {
                if (isUser) return;
                const selectedJudge = judges.find((j) => String(j.id) === value);
                if (selectedJudge?.reviewPrompt) {
                  form.setValue('judgingPrompt', selectedJudge.reviewPrompt);
                } else {
                  form.setValue('judgingPrompt', '');
                }
              }}
              allowDeselect={false}
              withAsterisk={isUser}
              disabled={isActive || isTerminal}
            />
            {!isUser && (
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
            )}
            {!isUser && (
              <>
                <Divider label="Categories" />
                <Switch
                  label="Customize judging categories"
                  description="Replace the default scoring rubric with your own weighted categories."
                  checked={customizeCategories}
                  onChange={(event) =>
                    handleCustomizeCategoriesChange(event.currentTarget.checked)
                  }
                  disabled={isActive || isTerminal}
                />
                {customizeCategories ? (
                  <CategoryWeights disabled={isActive || isTerminal} />
                ) : (
                  <Text size="sm" c="dimmed">
                    This challenge is judged against the default rubric until categories are
                    customized.
                  </Text>
                )}
                {(isActive || isTerminal) && (
                  <Text size="xs" c="dimmed">
                    Judging categories can no longer be changed once the challenge has started.
                  </Text>
                )}
              </>
            )}
            {isUser && (
              <>
                <Divider label="Categories" />
                <Text size="sm" c="dimmed">
                  These categories and how they&apos;re scored are shown publicly so entrants know
                  exactly how they&apos;ll be judged. The defaults below are a sensible starting point
                  — adjust or replace them however you like (weights must total 100%).
                </Text>
                <CategoryWeights disabled={isActive || isTerminal} />
              </>
            )}
          </Stack>
        </Paper>

        {/* Event (moderator-only) */}
        {!isUser && (
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
        )}

        {/* Source (moderator-only; user challenges are always ChallengeSource.User) */}
        {!isUser && (
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
        )}

        {/* Actions */}
        <Group justify="flex-end" wrap="wrap">
          <Button
            variant="default"
            onClick={() => router.push(isUser ? '/challenges' : '/moderator/challenges')}
            fullWidth
            className="sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            loading={form.formState.isSubmitting || upsertMutation.isPending || upsertUserMutation.isPending}
            disabled={isTerminal}
            fullWidth
            className="sm:w-auto"
          >
            {isEditing ? 'Update Challenge' : isUser ? 'Submit Challenge' : 'Create Challenge'}
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

type JudgeOptionItem = { id: number; name: string; bio?: string | null };

const renderJudgeOption = ({
  option,
  checked,
  judges,
}: Parameters<NonNullable<SelectProps['renderOption']>>[0] & { judges: JudgeOptionItem[] }) => {
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
