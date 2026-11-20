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
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { takeClusterWindowCount } from '~/server/utils/cluster-window-count';
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
  `${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_DAILY}:${userId}:${day}` as const;
const submitKey = (workflowId: string) =>
  `${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_SUBMITTED}:${workflowId}` as const;

export type StudioAutoLabelResult = {
  key: string;
  status: 'succeeded' | 'failed' | 'pending';
  tags?: string[];
  caption?: string;
  error?: string;
  /** The step was turned away before it ran, so the same item may be sent again. */
  retryable?: boolean;
};

export const AUTO_LABEL_BUSY = 'Auto-labeling is busy right now.';
export const AUTO_LABEL_STEP_FAILED = 'Auto-labeling failed for this image.';

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
  // SET NX EX + INCRBY in one MULTI, so the count always carries its TTL. A failure or a reply
  // that is not a number refuses the submit.
  const total = await takeClusterWindowCount('reserveDailyItems', key, QUOTA_TTL_SECONDS, {
    by: count,
  });
  if (!Number.isFinite(total)) throw new Error('auto-label daily quota unreadable');
  const release = async () => {
    await takeClusterWindowCount('reserveDailyItems.release', key, QUOTA_TTL_SECONDS, {
      by: -count,
    }).catch(() => undefined);
  };
  if (total > STUDIO_AUTO_LABEL_DAILY_ITEMS) {
    await release();
    throw throwRateLimitError(
      `You've reached today's auto-label limit (${STUDIO_AUTO_LABEL_DAILY_ITEMS} items). It resets at midnight UTC.`
    );
  }
  return { release, day };
}

/** The Studio sends an item turned away before it ran up to this many times (apps/training-studio
 *  autolabel.ts BUSY_RETRY_DELAYS_MS, plus the first send), so busy refusals get their own, wider
 *  give-back allowance: one refused item must not use up the allowance ordinary failures rely on. */
const BUSY_SENDS_PER_ITEM = 4;
type FailedStep = { name: string; busy: boolean };

/** Gives each failed step's item back to the quota it was counted against, once per step however
 *  often the workflow is polled, and only for a workflow this service submitted for this user (its
 *  submit record), never more items than it counted, and at most the daily limit per day (busy
 *  refusals: that times BUSY_SENDS_PER_ITEM, counted apart). Only today's quota: an earlier day's has no use
 *  for it, and a decrement on an expired key would leave a negative counter with no TTL. Best effort:
 *  a poll is never failed by it, and a miss only keeps the item counted, as before. */
async function releaseFailedItems(workflowId: string, userId: number, failedSteps: FailedStep[]) {
  if (!failedSteps.length) return;
  try {
    const raw = await redis.get(submitKey(workflowId));
    const record = raw ? (JSON.parse(raw) as SubmitRecord) : null;
    if (!record || record.userId !== userId || record.day !== utcDay()) return;
    // Steps are named by index at submit.
    const counted = failedSteps.filter(
      ({ name }) => /^\d+$/.test(name) && Number(name) < record.count
    );
    const releasedKey = `${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_RELEASED}:${workflowId}` as const;
    for (const busy of [false, true]) {
      const names = counted.filter((s) => s.busy === busy).map((s) => s.name);
      if (!names.length) continue;
      const added = await redis.sAdd(releasedKey, names);
      if (added === 0) continue;
      await redis.expire(releasedKey, QUOTA_TTL_SECONDS);
      // Backstop: at most this many come back per day; past it, failed items stay counted.
      const limit = STUDIO_AUTO_LABEL_DAILY_ITEMS * (busy ? BUSY_SENDS_PER_ITEM : 1);
      const releasedDailyKey = `${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_RELEASED_DAILY}:${userId}:${
        record.day
      }${busy ? ':busy' : ''}` as const;
      const released = await redis.incrBy(releasedDailyKey, added);
      if (released === added) await redis.expire(releasedDailyKey, QUOTA_TTL_SECONDS);
      const allowed = Math.min(added, Math.max(0, limit - (released - added)));
      if (allowed > 0)
        await takeClusterWindowCount(
          'releaseFailedItems',
          dailyKey(userId, record.day),
          QUOTA_TTL_SECONDS,
          { by: -allowed }
        );
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

  const failedSteps: FailedStep[] = [];
  const results = (data.steps ?? []).map((raw, index): StudioAutoLabelResult => {
    const step = raw as {
      name?: string | null;
      status: string;
      startedAt?: string | null;
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
      // The workflow read carries no failure reason. A step that ended without starting was refused
      // at scheduling (no worker free), not by its input.
      const busy = !step.startedAt && step.status !== 'canceled';
      failedSteps.push({ name: step.name ?? String(index), busy });
      if (busy) return { key, status: 'failed', error: AUTO_LABEL_BUSY, retryable: true };
      return { key, status: 'failed', error: AUTO_LABEL_STEP_FAILED };
    }
    return { key, status: 'pending' };
  });
  await releaseFailedItems(workflowId, userId, failedSteps);

  return { done: TERMINAL_STATUSES.has(data.status ?? ''), results };
}
