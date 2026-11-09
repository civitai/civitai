/**
 * A LIVE on-site app on the shared static server, behind the `app-blocks-live-unpublish` flag.
 *
 * Taking it down: suspending the block (what every delist path does) stops the on-site runtime;
 * the app's own subdomain is served by the shared static server from the app's live pointer,
 * which only the live unpublish Job removes.
 *
 * Restoring it: the relist paths re-run the live publish Job for the app's approved build. The
 * build's files and meta are still in the bucket (a takedown deletes only the pointer), so that
 * publish uploads nothing and only writes the pointer back.
 *
 * The shared server's readiness app is never taken down or re-published from here. The store
 * takedown itself still goes ahead for it; only the server-side step is skipped, and the
 * unpublish script refuses that app anyway.
 *
 * Callers (offsite-moderation.service): takedown from the moderator delist, the moderator reset to
 * pending and the owner unpublish; restore from the moderator relist and the owner republish.
 */
import { liveAppImageRef } from '~/server/services/blocks/app-block-image';

/** What this module reaches outside itself. Injectable for its tests. */
export type LiveUnpublishDeps = {
  flagOn: () => Promise<boolean>;
  readReadinessProbeSlugs: () => Promise<string[]>;
  triggerLiveUnpublish: (slug: string) => Promise<{ name: string }>;
  waitForJob: (name: string, timeoutMs: number) => Promise<'succeeded' | 'failed' | 'timeout'>;
  /** The block's approved sha and when it last deployed (null when it never did). */
  readLiveBuild: (
    appBlockId: string
  ) => Promise<{ sha: string | null; deployedAt: Date | null } | null>;
  perAppObjectsOn: () => Promise<boolean>;
  /** The live publish Job: the same apply Job a successful build runs. */
  triggerLivePublish: (args: {
    slug: string;
    sha: string;
    appBlockId: string;
    imageRef: string;
    perAppObjects: boolean;
  }) => Promise<{ name: string }>;
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
  perAppObjectsOn: async () =>
    (await import('~/server/services/app-blocks-flag')).isAppBlocksPerAppObjectsEnabled(),
  triggerLivePublish: async (args) => (await import('./apps-pipeline.service')).triggerApply(args),
};

/** The line the moderator gets back when the readiness app's store takedown went through. */
export function readinessAppNote(slug: string): string {
  return `${slug} keeps serving: it is the static server's readiness app`;
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
    return (await d.readReadinessProbeSlugs()).includes(slug);
  } catch (err) {
    warn(`readiness list unreadable for ${slug}`, err);
    return false;
  }
}

/**
 * After a takedown COMMITS: start the live unpublish for `slug` (not awaited) and return the
 * note for the moderator, if any. For the readiness app no Job is created and the note says the
 * app keeps serving. Never throws; the takedown already happened whatever this returns.
 */
export async function takeDownLiveApp(
  slug: string,
  opts: { waitTimeoutMs?: number; deps?: Partial<LiveUnpublishDeps> } = {}
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
 * script refusing the readiness app (`refused`) or failing (`failed`) is logged.
 */
export async function unpublishLiveApp(
  slug: string,
  opts: { waitTimeoutMs?: number; deps?: Partial<LiveUnpublishDeps> } = {}
): Promise<LiveUnpublishOutcome> {
  const d = { ...defaultDeps, ...opts.deps };
  try {
    if (!(await d.flagOn())) return 'disabled';
    const job = await d.triggerLiveUnpublish(slug);
    const outcome = await d.waitForJob(job.name, opts.waitTimeoutMs ?? 180_000);
    if (outcome === 'succeeded') return 'unpublished';
    const refused = await isReadinessProbeApp(slug, d);
    warn(
      refused
        ? `${slug} is the shared static server's readiness probe app: unpublish refused, not retried`
        : `live unpublish Job ${job.name} ended ${outcome}; ${slug} may still be served`,
      null
    );
    return refused ? 'refused' : 'failed';
  } catch (err) {
    warn(`live unpublish of ${slug} failed`, err);
    return 'failed';
  }
}

export type LiveRestoreOutcome =
  | 'disabled'
  | 'readiness-app'
  | 'no-live-build'
  | 'restored'
  | 'failed';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * After a relist COMMITS and the block is approved again: re-run the live publish Job for the
 * block's approved build, which writes the app's live pointer back. Fire-and-forget at the call
 * site; never throws and is never retried (a failure is logged). Skipped for the readiness app
 * (never taken down), and for a block with no deployed approved build (nothing to point at).
 */
export async function restoreLiveApp(
  input: { slug: string; appBlockId: string },
  opts: { waitTimeoutMs?: number; deps?: Partial<LiveUnpublishDeps> } = {}
): Promise<LiveRestoreOutcome> {
  const d = { ...defaultDeps, ...opts.deps };
  const { slug, appBlockId } = input;
  try {
    if (!(await d.flagOn())) return 'disabled';
    if (await isReadinessProbeApp(slug, d)) {
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
    const outcome = await d.waitForJob(job.name, opts.waitTimeoutMs ?? 8 * 60_000);
    if (outcome === 'succeeded') return 'restored';
    warn(`live restore Job ${job.name} ended ${outcome}; ${slug} may not be served`, null);
    return 'failed';
  } catch (err) {
    warn(`live restore of ${slug} failed`, err);
    return 'failed';
  }
}

function warn(what: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[live-unpublish] ${what}${
      err == null ? '' : `: ${err instanceof Error ? err.message : String(err)}`
    }`
  );
}
