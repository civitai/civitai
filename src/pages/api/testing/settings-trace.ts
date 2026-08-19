/**
 * Times each await that `/api/user/settings` performs, individually and bounded.
 *
 * GET /api/testing/settings-trace?token=<WEBHOOK_TOKEN>[&ms=10000][&pools=write][&userq=-8123]
 *   ms  per-step budget in milliseconds (default 10000)
 *
 * When one of those dependencies parks, the request hangs and the server log says only that the
 * client gave up — which step it was hanging in is exactly what it does not say. Each step here is
 * raced against its own budget, so the answer is which one.
 *
 * Reach for it BEFORE restarting a session that has gone bad; a restart destroys the only state
 * that can be measured. This repo is public: keep the output to timings and step names.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getUserContentSettings } from '~/server/services/user.service';
import { getTosMeta } from '~/server/services/content.service';
import { getCurrentAnnouncements } from '~/server/services/announcement.service';
import { getUserFollows } from '~/server/redis/caches';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { getBrowsingSettingAddons, getLiveNow } from '~/server/services/system-cache';
import { dbRead, dbWrite } from '~/server/db/client';
import { pgDbRead } from '~/server/db/pgDb';

type StepResult = { step: string; ms: number; outcome: 'ok' | 'threw' | 'HUNG'; detail?: string };

async function time<T>(step: string, budgetMs: number, fn: () => Promise<T>): Promise<StepResult> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<'HUNG'>((resolve) => {
    timer = setTimeout(() => resolve('HUNG'), budgetMs);
  });
  try {
    const result = await Promise.race([fn().then(() => 'ok' as const), budget]);
    return { step, ms: Date.now() - started, outcome: result === 'HUNG' ? 'HUNG' : 'ok' };
  } catch (e) {
    return {
      step,
      ms: Date.now() - started,
      outcome: 'threw',
      // Name and code only. Prisma and pg embed host:port — and sometimes the failing SQL — in
      // `message`, and this output lands in dev-server logs and in whatever gets pasted into a PR
      // on a public repo. The code (`P1001`) is the part anyone actually wants.
      detail:
        e instanceof Error
          ? [e.name, (e as { code?: string }).code].filter(Boolean).join(' ')
          : 'unknown',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Bounded at both ends. An unbounded `?ms=` would make the worst case of a debug endpoint a hang
  // of 13 sequential steps — in a change about unbounded hangs.
  const budgetMs = Math.min(60_000, Math.max(1000, Number(req.query.ms) || 10000));

  const domainColor = getRequestDomainColor(req);
  const steps: StepResult[] = [];

  // First-touch cost of each pool, measured before anything else has opened a connection.
  // `?pools=1` on a freshly started session is the only way to see it — every later request is
  // served by an already-open connection, which is why this is invisible once warm.
  if (req.query.pools) {
    const writeFirst = req.query.pools === 'write';
    const stepA = writeFirst
      ? await time('prisma dbWrite first touch', budgetMs, () => dbWrite.$queryRaw`SELECT 1`)
      : await time('prisma dbRead first touch', budgetMs, () => dbRead.$queryRaw`SELECT 1`);
    const stepB = writeFirst
      ? await time('prisma dbRead second', budgetMs, () => dbRead.$queryRaw`SELECT 1`)
      : await time('prisma dbWrite second', budgetMs, () => dbWrite.$queryRaw`SELECT 1`);
    steps.push(stepA, stepB);
  }

  // `?userq=<id>` runs the settings cache's own lookup SELECT on both pools, bypassing redis, so a
  // slow cache FILL can be attributed to the query rather than to the cache machinery around it.
  // The redis cache is shared across sessions, so a warm key hides this on every session but the
  // first — pick an id nobody has cached.
  const userq = Number(req.query.userq);
  if (Number.isFinite(userq) && req.query.userq) {
    const sql = `SELECT id, settings, "showNsfw", "blurNsfw", "autoplayGifs" FROM "User" WHERE id IN (${userq})`;
    steps.push(
      await time(`dbWrite lookup id=${userq}`, budgetMs, () => dbWrite.$queryRawUnsafe(sql))
    );
    steps.push(
      await time(`dbRead lookup id=${userq}`, budgetMs, () => dbRead.$queryRawUnsafe(sql))
    );
    // Same id through the full cache path. The redis key for it does not exist, so this is a real
    // cold fill: redis miss, whatever locking createCachedObject does, the SELECT, the redis write.
    steps.push(
      await time(`getUserContentSettings COLD id=${userq}`, budgetMs, () =>
        getUserContentSettings(userq)
      )
    );
    steps.push(
      await time(`getUserContentSettings warm id=${userq}`, budgetMs, () =>
        getUserContentSettings(userq)
      )
    );
  }

  // Sequential, in the real handler's order: a step that hangs is the one that would have hung
  // there, and running them concurrently would hide which came first.
  // Once, not twice. Calling it a second time doubles work on the step most suspected of hanging,
  // and the second call's own race meant a genuinely stuck session silently resolved to anonymous —
  // quietly changing what every later step measured.
  let userId = -1;
  const authStep = await time('getServerAuthSession', budgetMs, async () => {
    const session = await getServerAuthSession({ req, res });
    userId = session?.user?.id ?? -1;
  });
  steps.push(authStep);

  // Stop at the first parked step. Once one dependency hangs, the ones after it are measuring a
  // machine in a different state — and 13 sequential steps at the 60s cap is a 13-minute request
  // from an endpoint that exists because of unbounded hangs.
  //
  // Scoped to the MAIN sequence, not the whole array. `?pools=` and `?userq=` are caller-requested
  // side-quests, and they are also the likeliest to park — `?pools=` is for a freshly started
  // session, which is exactly when a first-touch hangs. A hang there is a finding in itself, not a
  // reason to abandon everything the endpoint exists to measure.
  const mainFrom = steps.length;
  const bail = () => steps.slice(mainFrom).some((step) => step.outcome === 'HUNG');
  if (!bail())
    steps.push(
      await time('getUserContentSettings', budgetMs, () => getUserContentSettings(userId))
    );
  if (!bail())
    steps.push(
      await time('getTosMeta', budgetMs, () => getTosMeta({ domainColor: domainColor ?? 'blue' }))
    );
  if (!bail())
    steps.push(
      await time('getCurrentAnnouncements', budgetMs, () =>
        getCurrentAnnouncements({ domain: domainColor, userId: userId > 0 ? userId : undefined })
      )
    );
  if (!bail())
    steps.push(
      await time('getUserFollows', budgetMs, () =>
        userId > 0 ? getUserFollows(userId) : Promise.resolve(undefined)
      )
    );
  if (!bail())
    steps.push(await time('getBrowsingSettingAddons', budgetMs, () => getBrowsingSettingAddons()));
  if (!bail()) steps.push(await time('getLiveNow', budgetMs, () => getLiveNow()));

  // The two database clients separately: /api/health exercises the raw pg pool, while these
  // handlers go through Prisma, so a green health check says nothing about the pool they use.
  if (!bail())
    steps.push(await time('prisma dbRead SELECT 1', budgetMs, () => dbRead.$queryRaw`SELECT 1`));
  if (!bail())
    steps.push(
      await time('raw pg pool SELECT 1', budgetMs, () =>
        pgDbRead.query('SELECT 1').then(() => null)
      )
    );

  res.status(200).json({
    // Whether a session resolved, not whose. A real user id in a public repo's log stream is not
    // something this endpoint needs to say.
    authenticated: userId > 0,
    budgetMs,
    hung: steps.filter((s) => s.outcome === 'HUNG').map((s) => s.step),
    steps,
  });
});
