import {
  recordAppReviewAutodeployEvent,
  type AppReviewAutodeployEvent,
} from '~/server/prom/app-review-autodeploy.metrics';
import {
  BUILDING_REVIEW_PREVIEW_STATES,
  STARTED_REVIEW_BUILD_DETAIL_MARK,
} from '~/shared/constants/app-review-preview.constants';

/**
 * The automatic half of the app review flow. A new pending publish request (ZIP submit or git
 * push) notifies the moderators and queues its review preview; queued previews build under a
 * platform-wide cap; a preview that goes live can start the agent code review under a platform-wide
 * daily budget. Every entry point here is best-effort: it never throws into the submit, the build
 * callback or a moderator action that triggered it.
 */

/** Review builds (building + deploying) allowed at once, platform-wide, for automatic starts. */
export const MAX_CONCURRENT_REVIEW_BUILDS = 3;

/**
 * A build slot whose row has not moved for this long is treated as free: a review build whose
 * callback never arrived must not hold a slot forever. Longer than a build plus the apply watcher's
 * whole budget.
 */
export const REVIEW_BUILD_SLOT_STALE_MS = 45 * 60 * 1000;

/** Automatic review builds per submitter per UTC day; past it the preview waits for a moderator. */
export const AUTO_REVIEW_BUILDS_PER_USER_PER_DAY = 20;

const AUTO_BUILD_BUDGET_TTL_SECONDS = 26 * 60 * 60;

// Advisory-lock class for the build-slot claim (`pg_advisory_xact_lock(class, 0)`).
const REVIEW_BUILD_SLOT_LOCK_CLASS = 0x72657631;
// Compiled into the statement: Postgres has no parameter form for SET (see free-placement.service).
const REVIEW_BUILD_SLOT_LOCK_TIMEOUT = '3s';

/** Who started a review preview, recorded on the preview detail for the audit trail. */
export type ReviewPreviewActor = { kind: 'moderator'; userId: number } | { kind: 'system' };
export const SYSTEM_REVIEW_ACTOR: ReviewPreviewActor = { kind: 'system' };

const record = (event: AppReviewAutodeployEvent) => recordAppReviewAutodeployEvent(event);

/**
 * The rows that hold a build slot at `now`. The one definition the cap and the panel share.
 *
 * Deliberately NOT limited to pending requests: a request superseded, withdrawn or decided while
 * its review build runs still has that build running, and so does a preview torn down mid-build
 * (no preview any more, its started-build detail kept). Either keeps its slot until the build's
 * callback settles it (releaseSettledBuildSlot) or the stale window passes. An approved row never
 * matches the first arm (its deploy_state carries the production values) and a row that never
 * started a review build never matches the second.
 */
export function buildSlotHolderWhere(now: Date) {
  return {
    deployUpdatedAt: { gt: new Date(now.getTime() - REVIEW_BUILD_SLOT_STALE_MS) },
    OR: [
      { deployState: { in: [...BUILDING_REVIEW_PREVIEW_STATES] } },
      { deployState: null, deployDetail: { contains: STARTED_REVIEW_BUILD_DETAIL_MARK } },
    ],
  };
}

export type ClaimedReviewRequest = {
  id: string;
  slug: string;
  bundleKey: string;
  forgejoCommitSha: string | null;
};

export type ReviewBuildSlotClaim =
  | {
      claimed: ClaimedReviewRequest;
      /**
       * `request` claims only: the deploy detail the claim overwrote, read in the same
       * transaction. Absent for `next-queued`.
       */
      replacedDeployDetail?: string | null;
    }
  /** Every slot is held (automatic claims only). */
  | { claimed: null; reason: 'full' }
  /** Nothing is queued (`next-queued`), or the row is no longer pending (`request`). */
  | { claimed: null; reason: 'nothing-to-claim' };

/**
 * Claim a build slot and move the claimed request to `preview-building`, under a transaction-scoped
 * advisory lock so two claims can never both take the last slot.
 *
 * `next-queued` takes the oldest `preview-queued` request, and only while a slot is free.
 * `request` is a moderator's start (or rebuild): admitted even when every slot is held, so a
 * moderator's explicit start jumps the automatic queue. Its build still holds a slot, so automatic
 * starts wait for it.
 */
export async function claimReviewBuildSlot(
  target:
    | { kind: 'next-queued' }
    | { kind: 'request'; publishRequestId: string; actor: ReviewPreviewActor }
): Promise<ReviewBuildSlotClaim> {
  const { dbWrite } = await import('~/server/db/client');
  const now = new Date();
  return dbWrite.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${REVIEW_BUILD_SLOT_LOCK_TIMEOUT}'`);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REVIEW_BUILD_SLOT_LOCK_CLASS}::int, 0::int)`;

    const select = { id: true, slug: true, bundleKey: true, forgejoCommitSha: true } as const;
    if (target.kind === 'next-queued') {
      const held = await tx.appBlockPublishRequest.count({ where: buildSlotHolderWhere(now) });
      const next = await tx.appBlockPublishRequest.findFirst({
        where: { status: 'pending', deployState: 'preview-queued' },
        orderBy: { deployUpdatedAt: 'asc' },
        select,
      });
      if (!next) return { claimed: null, reason: 'nothing-to-claim' as const };
      if (held >= MAX_CONCURRENT_REVIEW_BUILDS) return { claimed: null, reason: 'full' as const };
      const { count } = await tx.appBlockPublishRequest.updateMany({
        where: { id: next.id, status: 'pending', deployState: 'preview-queued' },
        data: claimData(SYSTEM_REVIEW_ACTOR, now),
      });
      if (count === 0) return { claimed: null, reason: 'nothing-to-claim' as const };
      return { claimed: next };
    }

    const row = await tx.appBlockPublishRequest.findFirst({
      where: { id: target.publishRequestId, status: 'pending' },
      select: { ...select, deployDetail: true },
    });
    if (!row) return { claimed: null, reason: 'nothing-to-claim' as const };
    await tx.appBlockPublishRequest.updateMany({
      where: { id: row.id, status: 'pending' },
      data: claimData(target.actor, now),
    });
    const { deployDetail, ...claimed } = row;
    return { claimed, replacedDeployDetail: deployDetail };
  });
}

function claimData(actor: ReviewPreviewActor, now: Date) {
  return {
    deployState: 'preview-building',
    // buildStartedAt from the claim on: a teardown before startClaimedReviewBuild's first write
    // must still leave the row holding its slot (STARTED_REVIEW_BUILD_DETAIL_MARK).
    deployDetail: JSON.stringify({
      ...reviewActorDetail(actor),
      buildStartedAt: now.toISOString(),
    }),
    deployUpdatedAt: now,
  };
}

/** The audit fields a preview detail carries for its actor. */
export function reviewActorDetail(actor: ReviewPreviewActor): {
  actor: 'moderator' | 'system';
  modUserId?: number;
} {
  return actor.kind === 'moderator'
    ? { actor: 'moderator', modUserId: actor.userId }
    : { actor: 'system' };
}

/**
 * Start queued review builds while slots are free. Runs every minute (job) and whenever a build
 * settles or a preview is torn down. Never throws.
 */
export async function drainReviewPreviewQueue(): Promise<{ started: number; waiting: boolean }> {
  try {
    const { dbRead } = await import('~/server/db/client');
    const queued = await dbRead.appBlockPublishRequest.count({
      where: { status: 'pending', deployState: 'preview-queued' },
    });
    if (queued === 0) return { started: 0, waiting: false };
    const { isAppBlocksReviewAutodeployEnabled } = await import(
      '~/server/services/app-blocks-flag'
    );
    if (!(await isAppBlocksReviewAutodeployEnabled())) {
      // The flag is the kill switch for automatic builds, so nothing queued is built. Hand the
      // queued previews back to "waiting for a moderator" (no preview) rather than leave them
      // queued, where nothing would ever start them and they never expire.
      const { dbWrite } = await import('~/server/db/client');
      await dbWrite.appBlockPublishRequest.updateMany({
        where: { status: 'pending', deployState: 'preview-queued' },
        data: { deployState: null, deployDetail: null, deployUpdatedAt: new Date() },
      });
      return { started: 0, waiting: false };
    }

    const { startClaimedReviewBuild } = await import('./publish-request.service');
    let started = 0;
    // Bounded: each pass fills a slot or stops. One pass more than the cap, so a queue longer
    // than the free slots ends on `full` (counted as a wait) rather than on the bound.
    for (let i = 0; i <= MAX_CONCURRENT_REVIEW_BUILDS; i++) {
      const claim = await claimReviewBuildSlot({ kind: 'next-queued' });
      if (!claim.claimed) {
        if (claim.reason === 'full') {
          record('build_cap_wait');
          return { started, waiting: true };
        }
        break;
      }
      try {
        await startClaimedReviewBuild(claim.claimed, SYSTEM_REVIEW_ACTOR);
        record('queued_started');
        started++;
      } catch (err) {
        record('start_failed');
        warn('drainReviewPreviewQueue', `start failed (id=${claim.claimed.id})`, err);
      }
    }
    return { started, waiting: false };
  } catch (err) {
    warn('drainReviewPreviewQueue', 'drain failed', err);
    return { started: 0, waiting: false };
  }
}

export type AutoStartOutcome =
  | 'disabled'
  | 'budget-refused'
  | 'budget-unavailable'
  | 'not-queued'
  | 'queued'
  | 'error';

/**
 * Queue a new pending request's review preview for an automatic build. Inert unless the
 * `app-blocks-review-autodeploy` flag is on. Past the submitter's daily budget (or when the budget
 * cannot be read) nothing is queued and the preview waits for a moderator, as before this existed.
 * Never throws.
 */
export async function autoStartReviewPreview(args: {
  publishRequestId: string;
  submittedByUserId: number;
}): Promise<AutoStartOutcome> {
  try {
    const { isAppBlocksReviewAutodeployEnabled } = await import(
      '~/server/services/app-blocks-flag'
    );
    if (!(await isAppBlocksReviewAutodeployEnabled())) return 'disabled';

    const budget = await takeAutoBuildBudget(args.submittedByUserId);
    if (budget !== 'ok') {
      record(budget === 'limited' ? 'budget_refused' : 'budget_unavailable');
      return budget === 'limited' ? 'budget-refused' : 'budget-unavailable';
    }

    const { dbWrite } = await import('~/server/db/client');
    const now = new Date();
    const { count } = await dbWrite.appBlockPublishRequest.updateMany({
      // Only a request with no preview yet: a moderator may already have started one.
      where: { id: args.publishRequestId, status: 'pending', deployState: null },
      data: {
        deployState: 'preview-queued',
        deployDetail: JSON.stringify({
          ...reviewActorDetail(SYSTEM_REVIEW_ACTOR),
          queuedAt: now.toISOString(),
        }),
        deployUpdatedAt: now,
      },
    });
    if (count === 0) {
      // A moderator started it first (or it left pending): this submit used no automatic build.
      await refundAutoBuildBudget(args.submittedByUserId);
      return 'not-queued';
    }
    record('auto_started');
    await drainReviewPreviewQueue();
    return 'queued';
  } catch (err) {
    warn('autoStartReviewPreview', `failed (id=${args.publishRequestId})`, err);
    return 'error';
  }
}

/**
 * Count one automatic build against the submitter's UTC-day budget. Fails CLOSED: an unreadable
 * counter is `unavailable`, which the caller treats like a spent budget.
 */
async function autoBuildBudgetKey(userId: number) {
  const { REDIS_SYS_KEYS } = await import('~/server/redis/client');
  const day = new Date().toISOString().slice(0, 10);
  return `${REDIS_SYS_KEYS.BLOCKS.REVIEW_AUTO_BUILDS}:${userId}:${day}` as const;
}

async function takeAutoBuildBudget(userId: number): Promise<'ok' | 'limited' | 'unavailable'> {
  const { sysRedis, withSysReadDeadline } = await import('~/server/redis/client');
  const key = await autoBuildBudgetKey(userId);
  try {
    const res = await withSysReadDeadline(
      sysRedis
        .multi()
        .set(key, '0', { NX: true, EX: AUTO_BUILD_BUDGET_TTL_SECONDS })
        .incr(key)
        .exec()
    );
    const used = Number(res?.[1]);
    if (!Number.isFinite(used)) return 'unavailable';
    return used <= AUTO_REVIEW_BUILDS_PER_USER_PER_DAY ? 'ok' : 'limited';
  } catch {
    return 'unavailable';
  }
}

/** Give back a build taken by {@link takeAutoBuildBudget}. Best-effort. */
async function refundAutoBuildBudget(userId: number): Promise<void> {
  try {
    const { sysRedis, withSysReadDeadline } = await import('~/server/redis/client');
    await withSysReadDeadline(sysRedis.decr(await autoBuildBudgetKey(userId)));
  } catch {
    // The counter expires with the day; a lost refund costs one build of budget.
  }
}

/** New-submission alerts per submitter per UTC hour, before they are rolled up. */
export const SUBMISSION_ALERTS_PER_USER_PER_HOUR = 10;

/**
 * Whether this submitter's next alert is posted: `alert` up to the hourly limit, `rollup` exactly
 * once when it is passed (one "more submissions" notice), `silent` after that. Fails to SILENT:
 * when the counter cannot be read no alert is posted, so an outage can never flood the channel.
 */
async function takeSubmissionAlertSlot(userId: number): Promise<'alert' | 'rollup' | 'silent'> {
  try {
    const { sysRedis, REDIS_SYS_KEYS, withSysReadDeadline } = await import('~/server/redis/client');
    const hour = new Date().toISOString().slice(0, 13);
    const key = `${REDIS_SYS_KEYS.BLOCKS.REVIEW_SUBMISSION_ALERTS}:${userId}:${hour}` as const;
    const res = await withSysReadDeadline(
      sysRedis
        .multi()
        .set(key, '0', { NX: true, EX: 2 * 60 * 60 })
        .incr(key)
        .exec()
    );
    const n = Number(res?.[1]);
    if (!Number.isFinite(n)) return 'silent';
    if (n <= SUBMISSION_ALERTS_PER_USER_PER_HOUR) return 'alert';
    return n === SUBMISSION_ALERTS_PER_USER_PER_HOUR + 1 ? 'rollup' : 'silent';
  } catch {
    return 'silent';
  }
}

export type NewPendingSubmission = {
  publishRequestId: string;
  slug: string;
  version: string;
  appName: string;
  submittedByUserId: number;
  origin: 'upload' | 'push';
};

/**
 * Everything that follows a NEW pending publish request: the moderator alert and the automatic
 * preview, both behind `app-blocks-review-autodeploy` (off: nothing is posted or queued). Called
 * fire-and-forget after the row commits, once per new request (not on a refresh of an existing
 * one). Never throws.
 */
export async function onNewPendingSubmission(sub: NewPendingSubmission): Promise<void> {
  try {
    const { isAppBlocksReviewAutodeployEnabled } = await import(
      '~/server/services/app-blocks-flag'
    );
    if (!(await isAppBlocksReviewAutodeployEnabled())) return;
  } catch (err) {
    warn('onNewPendingSubmission', `flag read failed (id=${sub.publishRequestId})`, err);
    return;
  }
  await Promise.allSettled([
    notifyModsOfNewSubmission(sub),
    autoStartReviewPreview({
      publishRequestId: sub.publishRequestId,
      submittedByUserId: sub.submittedByUserId,
    }),
  ]);
}

/**
 * Post the new submission to the moderator alerts channel, at most
 * {@link SUBMISSION_ALERTS_PER_USER_PER_HOUR} per submitter per hour, then one roll-up notice.
 * Never throws.
 */
export async function notifyModsOfNewSubmission(
  sub: NewPendingSubmission
): Promise<'delivered' | 'rejected' | 'unconfigured' | 'throttled' | 'error'> {
  try {
    const slot = await takeSubmissionAlertSlot(sub.submittedByUserId);
    if (slot === 'silent') return 'throttled';
    const [{ dbRead }, { getBaseUrl }, { notifyModAlert }] = await Promise.all([
      import('~/server/db/client'),
      import('~/server/utils/url-helpers'),
      import('~/server/common/mod-alert'),
    ]);
    const user = await dbRead.user
      .findUnique({ where: { id: sub.submittedByUserId }, select: { username: true } })
      .catch(() => null);
    const author = discordText(user?.username ?? `user ${sub.submittedByUserId}`, 60);
    if (slot === 'rollup') {
      return await notifyModAlert(
        `More app submissions from ${author}`,
        [
          `${author} has submitted more than ${SUBMISSION_ALERTS_PER_USER_PER_HOUR} apps this hour; further submissions this hour are not alerted.`,
          `Queue: ${getBaseUrl()}/apps/review`,
        ].join('\n'),
        { noMentions: true }
      );
    }
    const name = discordText(sub.appName, 100);
    const description = [
      `**${name}** ${discordText(sub.slug, 40)} v${discordText(sub.version, 32)}`,
      `Author: ${author}`,
      `Submitted by ${sub.origin === 'push' ? 'git push' : 'bundle upload'}`,
      `Review: ${getBaseUrl()}/apps/review/${sub.publishRequestId}`,
    ].join('\n');
    return await notifyModAlert(`New app submission: ${name}`, description, { noMentions: true });
  } catch (err) {
    warn('notifyModsOfNewSubmission', `failed (id=${sub.publishRequestId})`, err);
    return 'error';
  }
}

/**
 * Author-controlled text in a Discord embed: one line, bounded, with every markdown character
 * escaped (so `[label](url)` cannot render as a masked link) and `@` broken so it cannot read as a
 * mention. The webhook payload also disables mentions outright (`noMentions`).
 */
export function discordText(value: string, max: number): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, max)
    .replace(/[\\`*_~|>[\]()<#:-]/g, (c) => `\\${c}`)
    .replace(/@/g, '@\u200b');
}

/**
 * A review build left the building/deploying states (live, or failed). Frees its slot to the
 * queue and may start the agent review — whether or not the preview came up: the agent reads
 * the submitted bundle, not the preview, and every submission gets a review (a failed preview
 * still keeps the submission out of the moderator fast lane). Never throws.
 */
export async function onReviewBuildSettled(args: {
  publishRequestId: string;
  live: boolean;
}): Promise<void> {
  try {
    await drainReviewPreviewQueue();
    await maybeAutoStartAgentReview(args.publishRequestId);
  } catch (err) {
    warn('onReviewBuildSettled', `failed (id=${args.publishRequestId})`, err);
  }
}

export type AgentReviewAutostartOutcome =
  | 'disabled'
  | 'already-reviewed'
  | 'budget-refused'
  | 'started'
  | 'error';

/**
 * The agent review spend counted against today's platform budget (UTC day): the recorded cost of
 * every agent review started today, plus the per-review cap for each one started today with NO
 * cost reported, whatever its status. A torn-down, failed or swept run ends without the callback
 * ever recording its cost (the callback only writes `running` rows), so its real spend is unknown
 * and is counted at the most it could have been.
 */
export async function agentReviewSpendTodayUsd(now: Date = new Date()): Promise<number> {
  const [{ dbWrite }, { env }] = await Promise.all([
    import('~/server/db/client'),
    import('~/env/server'),
  ]);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [costed, uncosted] = await Promise.all([
    dbWrite.appReviewAgentReport.aggregate({
      where: { startedAt: { gte: dayStart }, costUsd: { not: null } },
      _sum: { costUsd: true },
    }),
    dbWrite.appReviewAgentReport.count({
      where: { startedAt: { gte: dayStart }, costUsd: null },
    }),
  ]);
  return (
    Number(costed._sum.costUsd ?? 0) +
    uncosted * perReviewCapUsd(env) +
    (await readListingCheckSpendUsd(now))
  );
}

async function listingCheckSpendKey(now: Date) {
  const { REDIS_SYS_KEYS } = await import('~/server/redis/client');
  return `${REDIS_SYS_KEYS.BLOCKS.LISTING_CHECK_SPEND}:${now.toISOString().slice(0, 10)}` as const;
}

/**
 * Today's model spend of the impersonation check on approved apps' listing edits, which has no
 * report row of its own to be counted from. Unreadable counts as nothing: the amounts are
 * fractions of a cent per check, and the reservation read below already refuses a start when
 * Redis cannot be read.
 */
async function readListingCheckSpendUsd(now: Date): Promise<number> {
  try {
    const { sysRedis, withSysReadDeadline } = await import('~/server/redis/client');
    const raw = await withSysReadDeadline(sysRedis.get(await listingCheckSpendKey(now)));
    const cents = Number(raw);
    return Number.isFinite(cents) && cents > 0 ? cents / 100 : 0;
  } catch {
    return 0;
  }
}

/** Add one listing-edit impersonation check's model spend to today's total. Best-effort. */
export async function recordListingCheckSpendUsd(usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) return;
  try {
    const { sysRedis, withSysReadDeadline } = await import('~/server/redis/client');
    const key = await listingCheckSpendKey(new Date());
    await withSysReadDeadline(
      sysRedis
        .multi()
        .set(key, '0', { NX: true, EX: 26 * 60 * 60 })
        .incrBy(key, Math.max(1, Math.round(usd * 100)))
        .exec()
    );
  } catch {
    // Lost spend only makes the day's total read low by a fraction of a cent.
  }
}

function perReviewCapUsd(env: { AGENT_REVIEW_COST_CAP_USD: string }): number {
  const cap = Number(env.AGENT_REVIEW_COST_CAP_USD);
  return Number.isFinite(cap) && cap > 0 ? cap : 0;
}

/**
 * Start the agent review for a request whose review build just settled (live or failed), when the
 * `app-blocks-agentic-review-autostart` flag is on and the `app-blocks-agentic-review` flag's base
 * value is on, no agent review has run for the request yet,
 * and one more review at its per-review cap fits in today's platform budget. Past the budget it is
 * refused; a moderator can still start one by hand. Never throws.
 */
export type AgentAutostartDeps = {
  /** The shared switch pair, `isAgentReviewAutomationEnabled`. */
  automationOn: () => Promise<boolean>;
  startAgentReview: (args: { publishRequestId: string; modUserId: null }) => Promise<unknown>;
};

export async function maybeAutoStartAgentReview(
  publishRequestId: string,
  /** Injectable for the concurrency test; defaults to the flags and agent-review service. */
  deps: Partial<AgentAutostartDeps> = {}
): Promise<AgentReviewAutostartOutcome> {
  try {
    const d: AgentAutostartDeps = {
      automationOn: async () =>
        (await import('~/server/services/app-blocks-flag')).isAgentReviewAutomationEnabled(),
      startAgentReview: async (args) =>
        (await import('./agent-review.service')).startAgentReview(args),
      ...deps,
    };
    if (!(await d.automationOn())) return 'disabled';

    const [{ dbRead }, { env }] = await Promise.all([
      import('~/server/db/client'),
      import('~/env/server'),
    ]);
    const existing = await dbRead.appReviewAgentReport.findFirst({
      where: { publishRequestId },
      select: { id: true },
    });
    if (existing) return 'already-reviewed';

    // Reserve this start's cap BEFORE reading today's spend, so concurrent go-lives cannot each
    // see room for one more and all start: every start in flight is counted (its reservation)
    // until its report row exists, after which the spend read counts it instead.
    const capCents = Math.round(perReviewCapUsd(env) * 100);
    const reservation = await reserveAgentAutostartBudget(capCents);
    if (reservation === null) {
      // The reservation cannot be read: refuse rather than start uncounted.
      record('agent_review_budget_refused');
      return 'budget-refused';
    }
    try {
      const spent = await agentReviewSpendTodayUsd();
      if (spent + reservation.totalCents / 100 > env.AGENT_REVIEW_AUTOSTART_DAILY_BUDGET_USD) {
        record('agent_review_budget_refused');
        return 'budget-refused';
      }
      await d.startAgentReview({ publishRequestId, modUserId: null });
      record('agent_review_auto_started');
      return 'started';
    } finally {
      // Released on the key it was taken on, even when the UTC day turned in between.
      await releaseAgentAutostartBudget(capCents, reservation.key);
    }
  } catch (err) {
    record('agent_review_start_failed');
    warn('maybeAutoStartAgentReview', `failed (id=${publishRequestId})`, err);
    return 'error';
  }
}

type AgentAutostartReservedKey = Awaited<ReturnType<typeof agentAutostartReservedKey>>;

async function agentAutostartReservedKey() {
  const { REDIS_SYS_KEYS } = await import('~/server/redis/client');
  const day = new Date().toISOString().slice(0, 10);
  return `${REDIS_SYS_KEYS.BLOCKS.AGENT_REVIEW_AUTOSTART_RESERVED}:${day}` as const;
}

/**
 * Add `cents` to today's in-flight reservation. Returns the new total and the key it was taken on
 * (the release must use the same one), or null when unreadable.
 */
async function reserveAgentAutostartBudget(
  cents: number
): Promise<{ totalCents: number; key: AgentAutostartReservedKey } | null> {
  try {
    const { sysRedis, withSysReadDeadline } = await import('~/server/redis/client');
    const key = await agentAutostartReservedKey();
    const res = await withSysReadDeadline(
      sysRedis
        .multi()
        .set(key, '0', { NX: true, EX: 26 * 60 * 60 })
        .incrBy(key, cents)
        .exec()
    );
    const total = Number(res?.[1]);
    return Number.isFinite(total) ? { totalCents: total, key } : null;
  } catch {
    return null;
  }
}

/** Release a reservation taken by {@link reserveAgentAutostartBudget}. Best-effort. */
async function releaseAgentAutostartBudget(
  cents: number,
  key: AgentAutostartReservedKey
): Promise<void> {
  try {
    const { sysRedis, withSysReadDeadline } = await import('~/server/redis/client');
    await withSysReadDeadline(sysRedis.incrBy(key, -cents));
  } catch {
    // The key expires with the day; a lost release only makes later starts more conservative.
  }
}

function warn(fn: string, what: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[${fn}] ${what}: ${err instanceof Error ? err.message : String(err)}`);
}
