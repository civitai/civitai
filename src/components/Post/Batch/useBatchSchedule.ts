import { keepPreviousData } from '@tanstack/react-query';
import { useDebouncedValue } from '@mantine/hooks';
import { useMemo } from 'react';
import type { ScheduleIssue, SchedulePerDay } from '@civitai/shared/post-scheduling';
import {
  addMonthsClamped,
  POST_BATCH_MAX_POSTS,
  POST_MAXIMUM_SCHEDULE_MONTHS,
  validateBatchSchedule,
} from '@civitai/shared/post-scheduling';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';
import { useBatchComposerStore } from './batch-composer.store';
import type { PlannedPost, UploadedMedia } from './batch-composer.utils';
import { buildPlan, generateBatchDates, groupIntoPosts } from './batch-composer.utils';

const DAY_MS = 86_400_000;
/** `post.getScheduled` refuses a range over 45 days; three of these cover the 3-month window. */
const SCHEDULED_WINDOW_DAYS = 45;
const SCHEDULED_WINDOWS = 3;

export type BatchPlan = {
  uploaded: UploadedMedia[];
  postCount: number;
  dates: Date[];
  generationIssue: string | null;
  posts: PlannedPost[];
};

/** The posts the composer would create right now: uploaded media grouped, dated and titled. */
export function useBatchPlan(names: { model?: string | null; version?: string | null }): BatchPlan {
  const [media, imagesPerPost, schedule, seed, fixedDates, titleTemplate] = useBatchComposerStore(
    (state) => [
      state.media,
      state.imagesPerPost,
      state.schedule,
      state.seed,
      state.fixedDates,
      state.shared.titleTemplate,
    ]
  );
  return useMemo(() => {
    const uploaded = media.filter((x): x is UploadedMedia => x.status === 'added');
    const postCount = groupIntoPosts(uploaded, imagesPerPost).length;
    const generated = postCount ? generateBatchDates(schedule, postCount, seed) : null;
    const dates =
      fixedDates && fixedDates.length === postCount
        ? fixedDates
        : generated?.ok
        ? generated.dates
        : [];
    const posts = dates.length
      ? buildPlan({
          media: uploaded,
          imagesPerPost,
          dates,
          titleTemplate,
          model: names.model,
          version: names.version,
        })
      : [];
    return {
      uploaded,
      postCount,
      dates,
      generationIssue: generated && !generated.ok ? generated.issue : null,
      posts,
    };
  }, [media, imagesPerPost, schedule, seed, fixedDates, titleTemplate, names.model, names.version]);
}

export type BatchScheduleValidation = {
  ok: boolean;
  checking: boolean;
  issues: ScheduleIssue[];
  perDay: SchedulePerDay[];
  dailyLimit: number | null;
  minGapMinutes: number | null;
  existing: Date[];
  existingTruncated: boolean;
};

function scheduledWindows(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(addMonthsClamped(now, POST_MAXIMUM_SCHEDULE_MONTHS).getTime() + DAY_MS);
  return Array.from({ length: SCHEDULED_WINDOWS }, (_, i) => {
    const from = new Date(start.getTime() + i * SCHEDULED_WINDOW_DAYS * DAY_MS);
    const to = new Date(Math.min(from.getTime() + SCHEDULED_WINDOW_DAYS * DAY_MS, end.getTime()));
    return { from, to, enabled: from < end };
  });
}

/**
 * Runs the shared validator against the creator's existing schedule for an instant answer, and
 * asks the server for the authoritative one. `ok` needs both; the issues shown are the local ones
 * when there are any (they arrive first) and the server's otherwise.
 */
export function useBatchScheduleValidation(
  dates: Date[],
  options: { enabled?: boolean } = {}
): BatchScheduleValidation {
  const { enabled = true } = options;
  const features = useFeatureFlags();
  const plannerOn = !!features.postPlanner;

  const key = dates.map((date) => date.getTime()).join(',');
  const [debouncedKey] = useDebouncedValue(key, 300);
  const debouncedDates = useMemo(
    () => (debouncedKey ? debouncedKey.split(',').map((ms) => new Date(Number(ms))) : []),
    [debouncedKey]
  );
  const askServer =
    enabled && debouncedDates.length > 0 && debouncedDates.length <= POST_BATCH_MAX_POSTS;
  const server = trpc.post.validateBatchSchedule.useQuery(
    { publishedAts: debouncedDates },
    { enabled: askServer, placeholderData: keepPreviousData }
  );

  const today = new Date().toISOString().slice(0, 10);
  const windows = useMemo(() => scheduledWindows(new Date()), [today]); // eslint-disable-line react-hooks/exhaustive-deps
  const windowOptions = (index: number) => ({
    enabled: enabled && plannerOn && windows[index].enabled,
    staleTime: 60_000,
  });
  const first = trpc.post.getScheduled.useQuery(windows[0], windowOptions(0));
  const second = trpc.post.getScheduled.useQuery(windows[1], windowOptions(1));
  const third = trpc.post.getScheduled.useQuery(windows[2], windowOptions(2));
  const ranges = [first, second, third];

  const existing = useMemo(
    () =>
      ranges.flatMap((range) => range.data?.posts.map((post) => new Date(post.publishedAt)) ?? []),
    [first.data, second.data, third.data] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const existingLoading = plannerOn && ranges.some((range) => range.isLoading);
  const existingTruncated = ranges.some((range) => !!range.data?.truncated);
  const dailyLimit = server.data?.dailyLimit ?? first.data?.dailyLimit ?? null;
  const minGapMinutes = first.data?.minGapMinutes ?? null;

  const local = useMemo(
    () =>
      dates.length
        ? validateBatchSchedule({
            now: new Date(),
            publishedAts: dates,
            existingPublishedAts: existing,
            dailyLimit: dailyLimit ?? Number.POSITIVE_INFINITY,
          })
        : null,
    [key, existing, dailyLimit] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const serverSettled = askServer && !!server.data && key === debouncedKey && !server.isFetching;
  const issues = !enabled
    ? []
    : local && !local.ok
    ? local.issues
    : server.data?.issues ?? local?.issues ?? [];
  const perDay = plannerOn || !server.data ? local?.perDay ?? [] : server.data.perDay;

  return {
    ok: !!local?.ok && serverSettled && !!server.data?.ok,
    checking:
      existingLoading || (askServer && (server.isFetching || key !== debouncedKey)) || false,
    issues,
    perDay,
    dailyLimit,
    minGapMinutes,
    existing,
    existingTruncated,
  };
}
