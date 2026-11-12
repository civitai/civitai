/**
 * A LIVE on-site app's pointer on the shared static server.
 *
 * The app's own subdomain is served from its live pointer. Suspending the block (what every delist
 * path does) stops the on-site runtime but not that; behind `app-blocks-live-unpublish` the
 * takedown paths also remove the pointer, and a relist writes it back.
 *
 * The takedown marker records two separate facts:
 *   - ATTEMPTED: this platform started an unpublish of the app. Set before the Job starts, because
 *     a Job that fails may still have removed the pointer; it is the evidence a restore runs on.
 *   - CONFIRMED: an unpublish Job of the app succeeded. Only this stops a later takedown from
 *     running the unpublish again.
 * A restore downgrades the marker to attempted before its Job starts (a restore Job that fails
 * may still write the pointer) and clears it when the Job succeeds. An unpublish whose
 * confirmation finds the marker cleared (a deploy wrote the pointer while the Job ran, and the Job
 * may have removed it after) records the attempt again, so the evidence is never lost.
 *
 * ONE reconciler per app ({@link syncLivePointer}) does both. It never acts on what a caller
 * intended, only on the app's CURRENT state, read each time it decides:
 *   - block suspended, flag on, takedown not confirmed, not the readiness app → unpublish;
 *   - block approved and a takedown attempted or confirmed → restore: re-publish the approved
 *     build, which uploads nothing (its files and meta are still in the bucket) and writes the
 *     pointer back; the marker is cleared when that succeeds.
 * A restore runs on the marker whatever the flag says now, so an app taken down while the flag
 * was on comes back after it is turned off; with no marker a relist does nothing here.
 *
 * Ordering: the Jobs of one app run one at a time (a per-app lock) under one shared Job name. A
 * caller asks for a look (DIRTY) BEFORE it tries the lock, so a holder that lets go in between
 * still sees the request when it checks after its release; the holder re-reads
 * the app after every Job until nothing is left to do, so the newest state wins however the
 * takedowns and relists interleave. The lock is renewed before each Job; a holder that dies leaves
 * it to expire LOCK_TTL_S after its last renewal.
 *
 * Every Job failure is reported as an `app-blocks-live-pointer` warning, not only logged: the
 * moderator's response returns before the Job ends. A failed step is not retried within a run;
 * the next takedown, relist or deploy of the app reconciles it again from the app's state.
 *
 * Callers: takedown from the moderator delist, the moderator reset to pending and the owner
 * unpublish, restore from the moderator relist and the owner republish (offsite-moderation.service)
 * and from the approve that un-suspends the block after a reviewed republish
 * (offsite-listing.service); the after-deploy check from build-callback.
 */
import { liveAppImageRef } from '~/server/services/blocks/app-block-image';

type JobOutcome = 'succeeded' | 'failed' | 'timeout';
type PointerJob =
  | { slug: string; action: 'unpublish' }
  | { slug: string; action: 'restore'; sha: string; imageRef: string };

/** What this platform did to the app's pointer (see the module doc). */
export type TakedownState = 'none' | 'attempted' | 'confirmed';

/** Per-app state this module keeps (Redis in production). */
export type LivePointerStore = {
  readTakedown: (slug: string) => Promise<TakedownState>;
  /** Record that an unpublish is starting. */
  markTakedownAttempted: (slug: string) => Promise<void>;
  /**
   * Record that the unpublish succeeded. Only upgrades a recorded attempt; false when there was
   * none (a deploy cleared the marker while the Job ran).
   */
  markTakedownConfirmed: (slug: string) => Promise<boolean>;
  clearTakedown: (slug: string) => Promise<void>;
  /** Take the app's lock; false when another run holds it. */
  acquire: (slug: string) => Promise<boolean>;
  /** Extend the held lock before a Job. */
  refresh: (slug: string) => Promise<void>;
  release: (slug: string) => Promise<void>;
  markDirty: (slug: string) => Promise<void>;
  /** Clear the app's dirty mark; true when it was set. */
  takeDirty: (slug: string) => Promise<boolean>;
};

/** What this module reaches outside itself. Injectable for its tests. */
export type LiveUnpublishDeps = {
  flagOn: () => Promise<boolean>;
  readReadinessProbeSlugs: () => Promise<string[]>;
  /** The app's block, read on the primary. */
  readBlockBySlug: (slug: string) => Promise<{ id: string; status: string } | null>;
  /** The block's approved sha and when it last deployed (null when it never did). */
  readLiveBuild: (
    appBlockId: string
  ) => Promise<{ sha: string | null; deployedAt: Date | null } | null>;
  triggerPointerJob: (job: PointerJob) => Promise<{ name: string }>;
  waitForJob: (name: string, timeoutMs: number) => Promise<JobOutcome>;
  store: LivePointerStore;
  /** A failure someone should see (not only a log line). */
  report: (message: string, details: Record<string, unknown>) => void;
};

/** One Job's budget: the restore's required publish, with slack. */
const JOB_TIMEOUT_MS = 8 * 60_000;
/** The lock's lifetime from its last renewal (one per Job): longer than one Job's budget. */
const LOCK_TTL_S = 10 * 60;
/** Steps one run may take before it reports that the app did not settle. */
const MAX_STEPS = 6;

const redisKeys = async () => {
  const { REDIS_SYS_KEYS } = await import('~/server/redis/client');
  return {
    takedown: (slug: string) => `${REDIS_SYS_KEYS.BLOCKS.LIVE_POINTER_TAKEDOWN}:${slug}` as const,
    lock: (slug: string) => `${REDIS_SYS_KEYS.BLOCKS.LIVE_POINTER_LOCK}:${slug}` as const,
    dirty: (slug: string) => `${REDIS_SYS_KEYS.BLOCKS.LIVE_POINTER_DIRTY}:${slug}` as const,
  };
};
const sys = async () => (await import('~/server/redis/client')).sysRedis;
const read = async <T>(p: Promise<T>) => (await import('~/server/redis/client')).withSysDeadline(p);

// The takedown key holds 'attempted' or 'confirmed'; any other value present reads as attempted.
const redisStore: LivePointerStore = {
  readTakedown: async (slug) => {
    const value = await read((await sys()).get((await redisKeys()).takedown(slug)));
    if (value == null) return 'none';
    return value === 'confirmed' ? 'confirmed' : 'attempted';
  },
  markTakedownAttempted: async (slug) => {
    await (await sys()).set((await redisKeys()).takedown(slug), 'attempted');
  },
  markTakedownConfirmed: async (slug) =>
    (await (await sys()).set((await redisKeys()).takedown(slug), 'confirmed', { XX: true })) !=
    null,
  clearTakedown: async (slug) => {
    await (await sys()).del((await redisKeys()).takedown(slug));
  },
  acquire: async (slug) =>
    !!(await read(
      (await sys()).set((await redisKeys()).lock(slug), '1', { NX: true, EX: LOCK_TTL_S })
    )),
  refresh: async (slug) => {
    await (await sys()).set((await redisKeys()).lock(slug), '1', { XX: true, EX: LOCK_TTL_S });
  },
  release: async (slug) => {
    await (await sys()).del((await redisKeys()).lock(slug));
  },
  markDirty: async (slug) => {
    await (await sys()).set((await redisKeys()).dirty(slug), '1', { EX: LOCK_TTL_S });
  },
  takeDirty: async (slug) => (await (await sys()).del((await redisKeys()).dirty(slug))) > 0,
};

const defaultDeps: LiveUnpublishDeps = {
  flagOn: async () =>
    (await import('~/server/services/app-blocks-flag')).isAppBlocksLiveUnpublishEnabled(),
  readReadinessProbeSlugs: async () =>
    (await import('./apps-pipeline.service')).readReadinessProbeSlugs(),
  readBlockBySlug: async (slug) => {
    const { dbWrite } = await import('~/server/db/client');
    return dbWrite.appBlock.findFirst({
      where: { blockId: slug },
      select: { id: true, status: true },
    });
  },
  readLiveBuild: async (appBlockId) => {
    const { dbWrite } = await import('~/server/db/client');
    const row = await dbWrite.appBlock.findUnique({
      where: { id: appBlockId },
      select: { currentVersionSha: true, currentVersionDeployedAt: true },
    });
    return row ? { sha: row.currentVersionSha, deployedAt: row.currentVersionDeployedAt } : null;
  },
  triggerPointerJob: async (job) =>
    (await import('./apps-pipeline.service')).triggerLivePointerJob(job),
  waitForJob: async (name, timeoutMs) =>
    (await import('./apps-pipeline.service')).waitForApplyJob(name, { timeoutMs }),
  store: redisStore,
  report: (message, details) => {
    void import('~/server/logging/client')
      .then(({ logToAxiom }) =>
        logToAxiom(
          { type: 'warning', name: 'app-blocks-live-pointer', message, details },
          'app-blocks'
        )
      )
      .catch(() => undefined);
  },
};

type Opts = { waitTimeoutMs?: number; deps?: Partial<LiveUnpublishDeps> };

/** The line the moderator gets back when the readiness app's store takedown went through. */
export function readinessAppNote(slug: string): string {
  return `${slug} keeps serving: it is the static server's readiness app`;
}

async function readinessListIncludes(slug: string, d: LiveUnpublishDeps): Promise<boolean> {
  try {
    return (await d.readReadinessProbeSlugs()).includes(slug);
  } catch (err) {
    warn(`readiness list unreadable for ${slug}`, err);
    return false;
  }
}

/**
 * Whether `slug` is one of the apps the shared static server uses as its readiness probe. Read
 * from the templates ConfigMap, never a copy, and only when the flag is on. Never throws and
 * never blocks a takedown: an unreadable list returns false, and the unpublish script (which
 * enforces the same list) refuses the app on its own.
 */
export async function isReadinessProbeApp(
  slug: string,
  deps: Partial<LiveUnpublishDeps> = {}
): Promise<boolean> {
  const d = { ...defaultDeps, ...deps };
  try {
    if (!(await d.flagOn())) return false;
  } catch (err) {
    warn(`flag unreadable for ${slug}`, err);
    return false;
  }
  return readinessListIncludes(slug, d);
}

/**
 * After a takedown COMMITS: start reconciling the app's pointer (not awaited) and return the note
 * for the moderator, if any. For the readiness app nothing is started and the note says the app
 * keeps serving. With the flag off, nothing. Never throws; the takedown already happened.
 */
export async function takeDownLiveApp(
  slug: string,
  opts: Opts = {}
): Promise<{ liveNote?: string }> {
  const d = { ...defaultDeps, ...opts.deps };
  try {
    if (!(await d.flagOn())) return {};
    if (await isReadinessProbeApp(slug, d)) {
      warn(`${slug} is the shared static server's readiness app: store takedown only`, null);
      return { liveNote: readinessAppNote(slug) };
    }
  } catch (err) {
    warn(`live takedown of ${slug} not started`, err);
    return {};
  }
  void syncLivePointer(slug, opts).catch(() => undefined);
  return {};
}

/**
 * After a relist COMMITS and the block is approved again: put the app back, but ONLY when this
 * platform attempted a takedown of it (the takedown marker), whatever the flag says now. With no
 * marker it does nothing else at all. Never throws.
 */
export async function restoreLiveApp(
  input: { slug: string; appBlockId: string },
  opts: Opts = {}
): Promise<'not-taken-down' | SyncOutcome> {
  const d = { ...defaultDeps, ...opts.deps };
  try {
    if ((await d.store.readTakedown(input.slug)) === 'none') return 'not-taken-down';
  } catch (err) {
    warn(`takedown marker of ${input.slug} unreadable; not restored`, err);
    d.report(`takedown marker of ${input.slug} unreadable; not restored`, {
      slug: input.slug,
      error: errorText(err),
    });
    return 'not-taken-down';
  }
  return syncLivePointer(input.slug, opts);
}

/** `restoreLiveApp`, not awaited and never failing the caller; a failed restore keeps the marker. */
export function restoreLiveAppSoon(input: { slug: string; appBlockId: string }): void {
  void restoreLiveApp(input).catch(() => undefined);
}

/**
 * After a deploy of an on-site app SUCCEEDS (build callback): the deploy wrote the pointer, so the
 * app is no longer taken down; a block suspended while the deploy ran is then taken down again
 * (flag-gated). Never throws.
 */
export async function afterLiveDeploy(
  slug: string,
  opts: Opts = {}
): Promise<'none' | SyncOutcome> {
  const d = { ...defaultDeps, ...opts.deps };
  try {
    if ((await d.store.readTakedown(slug)) !== 'none') await d.store.clearTakedown(slug);
    if (!(await d.flagOn())) return 'none';
    const block = await d.readBlockBySlug(slug);
    if (block?.status !== 'suspended') return 'none';
  } catch (err) {
    warn(`after-deploy check of ${slug} failed`, err);
    return 'none';
  }
  return syncLivePointer(slug, opts);
}

type Step = { action: 'unpublish' } | { action: 'restore'; appBlockId: string };
export type SyncOutcome = 'settled' | 'queued' | 'unsettled' | 'failed';

/** What the app needs now, from its CURRENT state. Null: nothing. */
async function nextStep(slug: string, d: LiveUnpublishDeps): Promise<Step | null> {
  const [block, takedown] = await Promise.all([
    d.readBlockBySlug(slug),
    d.store.readTakedown(slug),
  ]);
  if (block?.status === 'approved' && takedown !== 'none') {
    return { action: 'restore', appBlockId: block.id };
  }
  if (block?.status === 'suspended' && takedown !== 'confirmed' && (await d.flagOn())) {
    if (await readinessListIncludes(slug, d)) return null;
    return { action: 'unpublish' };
  }
  return null;
}

/**
 * Bring the app's pointer in line with its current state, one Job at a time (see the module doc).
 * Returns `queued` when another run holds the app (it will look again), `unsettled` when the app
 * kept changing past {@link MAX_STEPS}, `failed` when a step failed (reported; the next takedown,
 * relist or deploy reconciles the app again).
 */
export async function syncLivePointer(slug: string, opts: Opts = {}): Promise<SyncOutcome> {
  const d = { ...defaultDeps, ...opts.deps };
  try {
    // Asked BEFORE the lock is tried: a holder that releases between this caller's lock read and
    // any later write would otherwise never see the request. A holder consumes it as it reads.
    await d.store.markDirty(slug);
    if (!(await d.store.acquire(slug))) return 'queued';
  } catch (err) {
    warn(`live pointer lock of ${slug} unavailable`, err);
    d.report(`live pointer of ${slug} not reconciled: lock unavailable`, {
      slug,
      error: errorText(err),
    });
    return 'failed';
  }
  let outcome: SyncOutcome = 'settled';
  try {
    const failed = new Set<string>();
    let steps = 0;
    for (;;) {
      await d.store.takeDirty(slug);
      const step = await nextStep(slug, d);
      if (!step) break;
      if (failed.has(step.action)) {
        outcome = 'failed';
        break;
      }
      if (steps >= MAX_STEPS) {
        outcome = 'unsettled';
        d.report(`live pointer of ${slug} did not settle after ${MAX_STEPS} steps`, { slug });
        break;
      }
      steps++;
      await d.store.refresh(slug);
      if (!(await runStep(slug, step, d, opts))) failed.add(step.action);
    }
  } catch (err) {
    warn(`live pointer of ${slug} failed`, err);
    d.report(`live pointer of ${slug} failed`, { slug, error: errorText(err) });
    outcome = 'failed';
  } finally {
    await d.store.release(slug).catch(() => undefined);
  }
  // Asked to look again after the last read and before the release: run once more.
  if (await d.store.takeDirty(slug).catch(() => false)) return syncLivePointer(slug, opts);
  return outcome;
}

/** Run one step's Job and wait for it. True when it did what it set out to do. */
async function runStep(
  slug: string,
  step: Step,
  d: LiveUnpublishDeps,
  opts: Opts
): Promise<boolean> {
  if (step.action === 'unpublish') {
    // Recorded BEFORE the Job, which may remove the pointer and still fail: the evidence a later
    // relist restores on. Confirmed only once the Job succeeded, so a failed one is run again.
    await d.store.markTakedownAttempted(slug);
    const job = await d.triggerPointerJob({ slug, action: 'unpublish' });
    const jobOutcome = await d.waitForJob(job.name, opts.waitTimeoutMs ?? JOB_TIMEOUT_MS);
    if (jobOutcome === 'succeeded') {
      // No attempt left to confirm: a deploy cleared it while the Job ran, and the Job may have
      // removed the pointer that deploy wrote. Keep the evidence: re-reading decides what is next.
      if (!(await d.store.markTakedownConfirmed(slug))) await d.store.markTakedownAttempted(slug);
      return true;
    }
    const message = `live unpublish Job ${job.name} ended ${jobOutcome}; ${slug} may still be served`;
    warn(message, null);
    d.report(message, { slug, job: job.name, outcome: jobOutcome });
    return false;
  }

  const build = await d.readLiveBuild(step.appBlockId);
  const sha = build?.sha ?? '';
  if (!COMMIT_SHA.test(sha) || !build?.deployedAt || (await readinessListIncludes(slug, d))) {
    // Nothing to point at (or never to be touched): not taken down any more as far as this goes.
    warn(`${slug}: no deployed approved build to restore; takedown marker cleared`, null);
    await d.store.clearTakedown(slug);
    return true;
  }
  // A restore Job that fails may still write the pointer later, so from here the takedown is no
  // longer confirmed: a later takedown runs the unpublish again. Cleared when the Job succeeds.
  await d.store.markTakedownAttempted(slug);
  const job = await d.triggerPointerJob({
    slug,
    action: 'restore',
    sha,
    imageRef: liveAppImageRef(slug, sha),
  });
  const jobOutcome = await d.waitForJob(job.name, opts.waitTimeoutMs ?? JOB_TIMEOUT_MS);
  if (jobOutcome === 'succeeded') {
    await d.store.clearTakedown(slug);
    return true;
  }
  const message = `live restore Job ${job.name} ended ${jobOutcome}; ${slug} may not be served`;
  warn(message, null);
  d.report(message, { slug, job: job.name, outcome: jobOutcome });
  return false;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warn(what: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[live-unpublish] ${what}${err == null ? '' : `: ${errorText(err)}`}`);
}
