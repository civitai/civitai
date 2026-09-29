import { timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { env } from '~/env/server';
import { chunk, uniq } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { resourceDataCache } from '~/server/redis/resource-data.redis';
import { modelsSearchIndex } from '~/server/search-index';
import { versionIdFromAir } from '~/shared/utils/air';

/** `loaded` is in the payload and is NOT the answer: residency is `workersAvailable`. */
const eventSchema = z.object({
  air: z.string(),
  workersAvailable: z.number(),
  loaded: z.boolean().optional(),
  changedAt: z.string().optional(),
});

const schema = z.object({ events: z.array(eventSchema) });

const BATCH = 5000;

async function setLoaded(ids: number[], loaded: boolean) {
  if (!ids.length) return;
  // Raw SQL rather than updateMany, so Prisma's @updatedAt does not bump ModelVersion."updatedAt" —
  // it is on the public v1 payload and is remove-old-drafts' activity fence.
  for (const batch of chunk(ids, BATCH))
    await dbWrite.$executeRaw`
      UPDATE "ModelVersion" SET "generatorLoaded" = ${loaded} WHERE id = ANY(${batch}::int[])
    `;
}

function authorized(req: NextApiRequest) {
  const secret = env.WEBHOOK_TOKEN;
  if (!secret) return false;
  const raw = req.headers['x-webhook-secret'];
  const given = Array.isArray(raw) ? raw[0] : raw;
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  instrumentApiResponse(req, res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  if (!env.WEBHOOK_TOKEN) return res.status(503).json({ error: 'Endpoint not configured' });

  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: z.prettifyError(parsed.error) ?? 'Invalid payload' });

  // The same switch the sync job reads. While it is off the column freezes at its last value by
  // design, and a webhook writing anyway would leave that kill switch holding nothing.
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.SYNC_GENERATOR_LOADED_RESOURCES)))
    return res.status(200).json({ skipped: 'flag off', events: parsed.data.events.length });

  const resolved = parsed.data.events
    .map((event) => ({ id: versionIdFromAir(event.air), loaded: event.workersAvailable > 0 }))
    .filter((event): event is { id: number; loaded: boolean } => event.id != null);

  const versions = resolved.length
    ? await dbWrite.$queryRaw<{ id: number; modelId: number; generatorLoaded: boolean | null }[]>`
        SELECT id, "modelId", "generatorLoaded" FROM "ModelVersion" WHERE id = ANY(${resolved.map(
          (event) => event.id
        )}::int[])
      `
    : [];
  const known = new Map(versions.map((version) => [version.id, version.modelId]));
  // Only what actually MOVED. The orchestrator re-sends `workersAvailable` for resources whose
  // residency did not change, and acting on those costs a no-op UPDATE on a 1.2M-row table plus a
  // cache bust that turns the hour TTL into seconds for exactly the rows people generate with.
  const residency = new Map(versions.map((version) => [version.id, version.generatorLoaded]));
  const acted = resolved.filter(
    (event) => known.has(event.id) && residency.get(event.id) !== event.loaded
  );

  await setLoaded(
    acted.filter((event) => event.loaded).map((event) => event.id),
    true
  );
  await setLoaded(
    acted.filter((event) => !event.loaded).map((event) => event.id),
    false
  );

  // After the writes: a models sync draining the queue mid-write would index the old value.
  const modelIds = uniq(
    acted.map((event) => known.get(event.id)).filter((id): id is number => !!id)
  );
  if (modelIds.length)
    await modelsSearchIndex.queueUpdate(
      modelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );

  // Last, and after the enqueue for the reason the sync job gives. The SUBMIT path reads residency
  // from resourceDataCache, whose hour TTL would otherwise keep refusing a resource that has loaded.
  if (acted.length) await resourceDataCache.bust(acted.map((event) => event.id));

  logToAxiom({
    name: 'resource-availability-webhook',
    type: 'info',
    events: parsed.data.events.length,
    acted: acted.length,
    queued: modelIds.length,
  }).catch(() => undefined);

  return res.status(200).json({ events: parsed.data.events.length, acted: acted.length });
}
