/**
 * A LIVE on-site app on the shared static server.
 *
 * Taking it down (behind `app-blocks-live-unpublish`): suspending the block (what every delist path
 * does) stops the on-site runtime; the app's own subdomain is served by the shared static server
 * from the app's live pointer, which only the live unpublish Job removes.
 *
 * Restoring it: the relist paths re-run the live publish Job for the app's approved build. The
 * build's files and meta are still in the bucket (a takedown deletes only the pointer), so that
 * publish uploads nothing and only writes the pointer back. A restore runs whatever the flag says
 * now: the block went suspended → approved, which only a takedown path causes, and an app taken
 * down while the flag was on must come back after it is turned off. Writing the pointer of the
 * approved build an app already serves changes nothing.
 *
 * The Jobs run after the action commits and race each other and the app's own deploys, so each one
 * re-reads the block when it ends and corrects the pointer once if the block moved meanwhile:
 *   - an unpublish that ends after a relist approved the block again restores it;
 *   - a restore that ends after a new delist suspended the block takes it down;
 *   - a deploy (build callback) that ends while the block is suspended takes it down.
 *
 * The shared server's readiness app is never taken down or re-published from here. The store
 * takedown itself still goes ahead for it; only the server-side step is skipped, and the
 * unpublish script refuses that app anyway.
 *
 * Every Job failure is reported as an `app-blocks-live-pointer` warning, not only logged: the
 * moderator's response returns before the Job ends, so it cannot say whether the takedown worked.
 *
 * Callers: takedown from the moderator delist, the moderator reset to pending and the owner
 * unpublish, restore from the moderator relist and the owner republish (offsite-moderation.service);
 * the after-deploy check from build-callback.
 */
import { liveAppImageRef } from '~/server/services/blocks/app-block-image';

type JobOutcome = 'succeeded' | 'failed' | 'timeout';

/** What this module reaches outside itself. Injectable for its tests. */
export type LiveUnpublishDeps = {
  flagOn: () => Promise<boolean>;
  readReadinessProbeSlugs: () => Promise<string[]>;
  triggerLiveUnpublish: (slug: string) => Promise<{ name: string }>;
  waitForJob: (name: string, timeoutMs: number) => Promise<JobOutcome>;
  /** The block's approved sha and when it last deployed (null when it never did). */
  readLiveBuild: (
    appBlockId: string
  ) => Promise<{ sha: string | null; deployedAt: Date | null } | null>;
  /** The app's block, read on the primary when a Job ends. */
  readBlockBySlug: (slug: string) => Promise<{ id: string; status: string } | null>;
  perAppObjectsOn: () => Promise<boolean>;
  /** The live publish Job: the same apply Job a successful build runs. */
  triggerLivePublish: (args: {
    slug: string;
    sha: string;
    appBlockId: string;
    imageRef: string;
    perAppObjects: boolean;
  }) => Promise<{ name: string }>;
  /** A failure someone should see (not only a log line). */
  report: (message: string, details: Record<string, unknown>) => void;
};

const defaultDeps: LiveUnpublishDeps = {
  flagOn: async () =>
    (await import('~/server/services/app-blocks-flag')).isAppBlocksLiveUnpublishEnabled(),
  readReadinessProbeSlugs: async () =>
    (await import('./apps-pipeline.service')).readReadinessProbeSlugs(),
  triggerLiveUnpublish: async (slug) =>
    (await import('./apps-pipeline.service')).triggerLiveUnpublish(slug),
  waitForJob: async (name, timeoutMs) =>
    (await import('./apps-pipeline.service')).waitForApplyJob(name, { timeoutMs }),
  readLiveBuild: async (appBlockId) => {
    const { dbWrite } = await import('~/server/db/client');
    const row = await dbWrite.appBlock.findUnique({
      where: { id: appBlockId },
      select: { currentVersionSha: true, currentVersionDeployedAt: true },
    });
    return row ? { sha: row.currentVersionSha, deployedAt: row.currentVersionDeployedAt } : null;
  },
  readBlockBySlug: async (slug) => {
    const { dbWrite } = await import('~/server/db/client');
    return dbWrite.appBlock.findFirst({
      where: { blockId: slug },
      select: { id: true, status: true },
    });
  },
  perAppObjectsOn: async () =>
    (await import('~/server/services/app-blocks-flag')).isAppBlocksPerAppObjectsEnabled(),
  triggerLivePublish: async (args) => (await import('./apps-pipeline.service')).triggerApply(args),
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

type Opts = { waitTimeoutMs?: number; deps?: Partial<LiveUnpublishDeps>; reconcile?: boolean };

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
 * After a takedown COMMITS: start the live unpublish for `slug` (not awaited) and return the
 * note for the moderator, if any. For the readiness app no Job is created and the note says the
 * app keeps serving. Never throws; the takedown already happened whatever this returns.
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
  void unpublishLiveApp(slug, opts).catch(() => undefined);
  return {};
}

export type LiveUnpublishOutcome = 'disabled' | 'unpublished' | 'refused' | 'failed';

/**
 * Run the live unpublish Job for `slug` and wait for it. Never throws and is never retried: the
 * script refusing the readiness app (`refused`) or failing (`failed`) is reported. When it ends,
 * a block approved again meanwhile (a relist that raced it) is restored.
 */
export async function unpublishLiveApp(
  slug: string,
  opts: Opts = {}
): Promise<LiveUnpublishOutcome> {
  const d = { ...defaultDeps, ...opts.deps };
  let outcome: LiveUnpublishOutcome;
  try {
    if (!(await d.flagOn())) return 'disabled';
    const job = await d.triggerLiveUnpublish(slug);
    const jobOutcome = await d.waitForJob(job.name, opts.waitTimeoutMs ?? 180_000);
    if (jobOutcome === 'succeeded') {
      outcome = 'unpublished';
    } else {
      const refused = await isReadinessProbeApp(slug, d);
      outcome = refused ? 'refused' : 'failed';
      const message = refused
        ? `${slug} is the shared static server's readiness probe app: unpublish refused, not retried`
        : `live unpublish Job ${job.name} ended ${jobOutcome}; ${slug} may still be served`;
      warn(message, null);
      if (!refused) d.report(message, { slug, job: job.name, outcome: jobOutcome });
    }
  } catch (err) {
    warn(`live unpublish of ${slug} failed`, err);
    d.report(`live unpublish of ${slug} failed`, { slug, error: errorText(err) });
    return 'failed';
  }
  if (opts.reconcile !== false) {
    const block = await readBlock(slug, d);
    if (block?.status === 'approved') {
      warn(`${slug} was approved again while it was being taken down: restoring it`, null);
      await restoreLiveApp({ slug, appBlockId: block.id }, { ...opts, reconcile: false });
    }
  }
  return outcome;
}

export type LiveRestoreOutcome = 'readiness-app' | 'no-live-build' | 'restored' | 'failed';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * After a relist COMMITS and the block is approved again: re-run the live publish Job for the
 * block's approved build, which writes the app's live pointer back. Runs whatever the flag says
 * now (see the module doc). Fire-and-forget at the call site; never throws and is never retried
 * (a failure is reported). Skipped for the readiness app (never taken down), and for a block with
 * no deployed approved build (nothing to point at). When it ends, a block suspended again
 * meanwhile (a delist that raced it) is taken down.
 */
export async function restoreLiveApp(
  input: { slug: string; appBlockId: string },
  opts: Opts = {}
): Promise<LiveRestoreOutcome> {
  const d = { ...defaultDeps, ...opts.deps };
  const { slug, appBlockId } = input;
  let outcome: LiveRestoreOutcome;
  try {
    if (await readinessListIncludes(slug, d)) {
      warn(`${slug} is the shared static server's readiness app: no live restore`, null);
      return 'readiness-app';
    }
    const build = await d.readLiveBuild(appBlockId);
    const sha = build?.sha ?? '';
    if (!COMMIT_SHA.test(sha) || !build?.deployedAt) {
      warn(`${slug} has no deployed approved build to restore; not published`, null);
      return 'no-live-build';
    }
    const job = await d.triggerLivePublish({
      slug,
      sha,
      appBlockId,
      imageRef: liveAppImageRef(slug, sha),
      perAppObjects: await d.perAppObjectsOn(),
    });
    const jobOutcome = await d.waitForJob(job.name, opts.waitTimeoutMs ?? 8 * 60_000);
    if (jobOutcome === 'succeeded') {
      outcome = 'restored';
    } else {
      const message = `live restore Job ${job.name} ended ${jobOutcome}; ${slug} may not be served`;
      warn(message, null);
      d.report(message, { slug, job: job.name, outcome: jobOutcome });
      outcome = 'failed';
    }
  } catch (err) {
    warn(`live restore of ${slug} failed`, err);
    d.report(`live restore of ${slug} failed`, { slug, error: errorText(err) });
    return 'failed';
  }
  if (opts.reconcile !== false && outcome === 'restored') {
    const block = await readBlock(slug, d);
    if (block?.status === 'suspended') {
      warn(`${slug} was suspended again while it was being restored: taking it down`, null);
      await unpublishLiveApp(slug, { ...opts, reconcile: false });
    }
  }
  return outcome;
}

/**
 * After a deploy of an on-site app succeeds (build callback): a block suspended while the deploy
 * ran was taken down before this publish wrote the pointer back, so take it down again. Never
 * throws; does nothing for an approved block or with the flag off.
 */
export async function takeDownIfSuspendedAfterDeploy(
  slug: string,
  opts: Opts = {}
): Promise<'unpublished-again' | 'not-suspended' | LiveUnpublishOutcome> {
  const d = { ...defaultDeps, ...opts.deps };
  const block = await readBlock(slug, d);
  if (block?.status !== 'suspended') return 'not-suspended';
  warn(`${slug} was deployed while suspended: taking it down again`, null);
  const outcome = await unpublishLiveApp(slug, { ...opts, reconcile: false });
  return outcome === 'unpublished' ? 'unpublished-again' : outcome;
}

async function readBlock(slug: string, d: LiveUnpublishDeps) {
  try {
    return await d.readBlockBySlug(slug);
  } catch (err) {
    warn(`block of ${slug} unreadable`, err);
    return null;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warn(what: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[live-unpublish] ${what}${err == null ? '' : `: ${errorText(err)}`}`);
}
