/**
 * Take a LIVE on-site app off the shared static server when it is delisted, behind the
 * `app-blocks-live-unpublish` flag. Suspending the block (what every delist path does) stops the
 * on-site runtime; the app's own subdomain is served by the shared static server from the app's
 * live pointer, which only this removes.
 *
 * Callers: every path that suspends a live block — the moderator delist, the moderator reset to
 * pending and the owner unpublish (offsite-moderation.service).
 */

/** What this module reaches outside itself. Injectable for its tests. */
export type LiveUnpublishDeps = {
  flagOn: () => Promise<boolean>;
  readReadinessProbeSlugs: () => Promise<string[]>;
  triggerLiveUnpublish: (slug: string) => Promise<{ name: string }>;
  waitForJob: (name: string, timeoutMs: number) => Promise<'succeeded' | 'failed' | 'timeout'>;
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
};

/**
 * Whether `slug` is one of the apps the shared static server uses as its readiness probe, which
 * the unpublish script refuses to take down. Read from the templates ConfigMap, never a copy. Only
 * when the flag is on; an unreadable list returns false and the script remains the backstop.
 */
export async function isLiveUnpublishRefused(
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

export type LiveUnpublishOutcome = 'disabled' | 'unpublished' | 'refused' | 'failed';

/**
 * After a delist commits: run the live unpublish Job for `slug` and wait for it. Never throws
 * and is never retried: the script refusing the readiness app (`refused`) or failing (`failed`)
 * is logged. Callers do not await it.
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
    const refused = await isLiveUnpublishRefused(slug, d);
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

function warn(what: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[live-unpublish] ${what}${
      err == null ? '' : `: ${err instanceof Error ? err.message : String(err)}`
    }`
  );
}
