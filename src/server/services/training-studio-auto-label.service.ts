import type {
  AudioCaptioningStepTemplate,
  MediaCaptioningStepTemplate,
  WdTaggingStepTemplate,
  WorkflowStepTemplate,
} from '@civitai/orchestration-client';
import {
  getWorkflow as clientGetWorkflow,
  submitWorkflow as clientSubmitWorkflow,
} from '@civitai/orchestration-client';
import type {
  StudioAutoLabelPollInput,
  StudioAutoLabelSubmitInput,
} from '~/server/schema/training-studio-auto-label.schema';
import { REDIS_KEYS, REDIS_SYS_KEYS, redis, sysRedis } from '~/server/redis/client';
import { usageLimits, type UsageLimitRef } from '~/shared/constants/usage-limits';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import {
  assertCivitaiMediaUrls,
  assertSafeMediaUrls,
  toOrchestratorError,
} from '~/server/services/training.service';
import {
  throwBadRequestError,
  throwNotFoundError,
  throwRateLimitError,
} from '~/server/utils/errorHandling';

/**
 * The Training Studio's auto-label, run on the system token: it is free to the user, and a workflow
 * submitted with the user's own token is charged to them (empty `currencies` = any account). The
 * poll result is the Studio's `AutoLabelResult` (apps/training-studio/src/lib/autolabel-core.ts),
 * which both of its surfaces receive. Polls are scoped to the submitting user via metadata,
 * since the system token can read every workflow.
 */

const WD_THRESHOLD = 0.35;
const CAPTION_MAX_TOKENS = 300;
const CAPTION_TEMPERATURE = 0.7;
/** Items one user may auto-label per UTC day: p99 of per-user-day auto-label items over 14 days
 *  (1,133 on 2026-10-26), rounded up. */
export const STUDIO_AUTO_LABEL_DAILY_ITEMS = 1200;
/** Per-minute limits on `training.studioAutoLabelSubmit` / `studioAutoLabelPoll` and the standalone
 *  Studio's REST endpoint, from the usage-limit registry. `key` names the bucket (each procedure's
 *  tRPC path with `:`), so both surfaces share one quota per user. */
export const STUDIO_AUTO_LABEL_RATE_LIMITS = {
  submit: { key: 'training:studioAutoLabelSubmit', rules: usageLimits('auto-label.submit') },
  poll: { key: 'training:studioAutoLabelPoll', rules: usageLimits('auto-label.poll') },
} satisfies Record<string, { key: string; rules: UsageLimitRef }>;
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'expired', 'canceled']);

type StudioAutoLabelMetadata = { kind: 'studio-auto-label'; userId: number };
/** What a submit counted, keyed by its workflow id. Written only here, so a workflow the user built
 *  themselves (with the same metadata, on their own token) has none and can never release quota. */
type SubmitRecord = { userId: number; day: string; count: number };

const QUOTA_TTL_SECONDS = 2 * 24 * 60 * 60;
const utcDay = () => new Date().toISOString().slice(0, 10);
const dailyKey = (userId: number, day: string) =>
  `${REDIS_SYS_KEYS.TRAINING.STUDIO_AUTO_LABEL_DAILY}:${userId}:${day}` as const;
const submitKey = (workflowId: string) =>
  `${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_SUBMITTED}:${workflowId}` as const;

export type StudioAutoLabelResult = {
  key: string;
  status: 'succeeded' | 'failed' | 'pending';
  tags?: string[];
  caption?: string;
};

export async function submitStudioAutoLabel({
  userId,
  mode,
  media,
  items,
}: StudioAutoLabelSubmitInput & { userId: number }) {
  assertSafeMediaUrls(items.map((i) => i.mediaUrl));
  assertCivitaiMediaUrls(items.map((i) => i.mediaUrl));
  const { release, day } = await reserveDailyItems(userId, items.length);

  const steps: WorkflowStepTemplate[] = items.map((item, i) => {
    const metadata = { key: item.key };
    if (mode === 'tag') {
      const step: WdTaggingStepTemplate = {
        $type: 'wdTagging',
        name: `${i}`,
        input: { mediaUrl: item.mediaUrl, threshold: WD_THRESHOLD },
        metadata,
      };
      return step;
    }
    if (media === 'audio') {
      const step: AudioCaptioningStepTemplate = {
        $type: 'audioCaptioning',
        name: `${i}`,
        input: {
          mediaUrl: item.mediaUrl,
          temperature: CAPTION_TEMPERATURE,
          maxNewTokens: CAPTION_MAX_TOKENS,
          includeCaption: true,
          prepareForModeration: false,
        },
        metadata,
      };
      return step;
    }
    const step: MediaCaptioningStepTemplate = {
      $type: 'mediaCaptioning',
      name: `${i}`,
      input: { mediaUrl: item.mediaUrl, maxNewTokens: CAPTION_MAX_TOKENS },
      metadata,
    };
    return step;
  });

  const metadata: StudioAutoLabelMetadata = { kind: 'studio-auto-label', userId };
  const { data, error } = await clientSubmitWorkflow({
    client: internalOrchestratorClient,
    body: { tags: ['civitai', 'training-studio', 'auto-label'], metadata, steps, currencies: [] },
    query: { wait: 0 },
  }).catch(async (e: unknown) => {
    await release();
    throw e;
  });
  if (!data?.id) {
    await release();
    if (!data) toOrchestratorError(error);
    throw throwBadRequestError('Workflow submission returned no ID');
  }
  const record: SubmitRecord = { userId, day, count: items.length };
  // Lost, the run's failed items just stay counted, as before.
  await redis
    .set(submitKey(data.id), JSON.stringify(record), { EX: QUOTA_TTL_SECONDS })
    .catch((e: unknown) => console.warn('[training-studio] auto-label submit record failed', e));
  return { workflowId: data.id };
}

/** Counts `count` items against the user's UTC-day quota, refusing past it. Fails closed: if the
 *  counter can't be read, nothing is submitted. Returns a release for a submit that didn't happen. */
async function reserveDailyItems(userId: number, count: number) {
  const day = utcDay();
  const key = dailyKey(userId, day);
  const total = await sysRedis.incrBy(key, count);
  if (total === count) await sysRedis.expire(key, QUOTA_TTL_SECONDS);
  const release = async () => {
    await sysRedis.decrBy(key, count).catch(() => undefined);
  };
  if (total > STUDIO_AUTO_LABEL_DAILY_ITEMS) {
    await release();
    throw throwRateLimitError(
      `You've reached today's auto-label limit (${STUDIO_AUTO_LABEL_DAILY_ITEMS} items). It resets at midnight UTC.`
    );
  }
  return { release, day };
}

/** Gives each failed step's item back to the quota it was counted against, once per step however
 *  often the workflow is polled, and only for a workflow this service submitted for this user (its
 *  submit record), never more items than it counted, and at most the daily limit per day. Only today's quota: an earlier day's has no use
 *  for it, and a decrement on an expired key would leave a negative counter with no TTL. Best effort:
 *  a poll is never failed by it, and a miss only keeps the item counted, as before. */
async function releaseFailedItems(workflowId: string, userId: number, failedSteps: string[]) {
  if (!failedSteps.length) return;
  try {
    const raw = await redis.get(submitKey(workflowId));
    const record = raw ? (JSON.parse(raw) as SubmitRecord) : null;
    if (!record || record.userId !== userId || record.day !== utcDay()) return;
    // Steps are named by index at submit.
    const counted = failedSteps.filter((name) => /^\d+$/.test(name) && Number(name) < record.count);
    if (!counted.length) return;
    const releasedKey = `${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_RELEASED}:${workflowId}` as const;
    const added = await redis.sAdd(releasedKey, counted);
    if (added > 0) {
      await redis.expire(releasedKey, QUOTA_TTL_SECONDS);
      // Backstop: at most the daily limit comes back per day; past it, failed items stay counted.
      const releasedDailyKey =
        `${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_RELEASED_DAILY}:${userId}:${record.day}` as const;
      const released = await redis.incrBy(releasedDailyKey, added);
      if (released === added) await redis.expire(releasedDailyKey, QUOTA_TTL_SECONDS);
      const allowed = Math.min(
        added,
        Math.max(0, STUDIO_AUTO_LABEL_DAILY_ITEMS - (released - added))
      );
      if (allowed > 0) await sysRedis.decrBy(dailyKey(userId, record.day), allowed);
    }
  } catch (e) {
    console.warn('[training-studio] auto-label quota release failed', workflowId, e);
  }
}

export async function pollStudioAutoLabel({
  userId,
  workflowId,
}: StudioAutoLabelPollInput & { userId: number }): Promise<{
  done: boolean;
  results: StudioAutoLabelResult[];
}> {
  const { data, error } = await clientGetWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId },
  });
  if (!data) toOrchestratorError(error);

  const metadata = data.metadata as Partial<StudioAutoLabelMetadata> | undefined;
  // Another user's workflow, or one that isn't a Studio auto-label, reads as missing.
  if (metadata?.kind !== 'studio-auto-label' || metadata.userId !== userId)
    throw throwNotFoundError('Workflow not found');

  const failedSteps: string[] = [];
  const results = (data.steps ?? []).map((raw, index): StudioAutoLabelResult => {
    const step = raw as {
      name?: string | null;
      status: string;
      metadata?: { key?: string };
      output?: {
        tags?: Record<string, number>;
        caption?: string | null;
        results?: Record<string, { caption?: string | null; text?: string | null }>;
      };
    };
    const key = step.metadata?.key ?? '';
    if (step.status === 'succeeded') {
      const out = step.output;
      if (out?.tags)
        return {
          key,
          status: 'succeeded',
          tags: Object.entries(out.tags)
            .sort((a, b) => b[1] - a[1])
            .map(([tag]) => tag),
        };
      if (out?.caption != null) return { key, status: 'succeeded', caption: out.caption };
      if (out?.results) {
        const first = Object.values(out.results)[0];
        return { key, status: 'succeeded', caption: first?.text ?? first?.caption ?? '' };
      }
      return { key, status: 'succeeded' };
    }
    if (TERMINAL_STATUSES.has(step.status)) {
      failedSteps.push(step.name ?? String(index));
      return { key, status: 'failed' };
    }
    return { key, status: 'pending' };
  });
  await releaseFailedItems(workflowId, userId, failedSteps);

  return { done: TERMINAL_STATUSES.has(data.status ?? ''), results };
}
