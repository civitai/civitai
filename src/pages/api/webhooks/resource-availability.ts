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
import { modelsSearchIndex } from '~/server/search-index';
import { versionIdFromAir } from '~/shared/utils/air';

/**
 * The orchestrator tells us a resource entered or left the cluster, so the load indicators do not
 * wait out `sync-generator-loaded-resources`' five-minute cycle. That job stays, and stays
 * authoritative: this is an addition, so a delivery we miss self-heals within one cycle.
 *
 * Events arrive batched, buffered up to 2s on the orchestrator's side.
 */

/**
 * 🔴 `workersAvailable`, not `loaded`. Koen (2026-09-24): "loaded is a stupid property in that sense,
 * should not have added it, perhaps just look at workersAvailable" — `loaded: true` with no workers
 * never happens, and a resource with no worker cannot serve a generation whatever the flag says.
 */
const eventSchema = z.object({
  air: z.string(),
  workersAvailable: z.number(),
  loaded: z.boolean().optional(),
  changedAt: z.string().optional(),
});

const schema = z.object({ events: z.array(eventSchema) });

/** Ids per statement, matching the sync job so one delivery cannot lock the table for long. */
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

/**
 * `X-Webhook-Secret`, carrying the same `WEBHOOK_TOKEN` the orchestrator already presents to
 * image-scan-result and the training callbacks — as a header rather than `?token=`, which is how
 * every inbound third-party webhook here authenticates and keeps the secret out of request logs.
 */
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

  // Absent secret refuses every call rather than accepting them, and 503 says it is us, not them.
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

  // Rows we do not hold are not an error: the orchestrator serves resources from other sources, and
  // an AIR this parser cannot read is one we could not have acted on anyway.
  const versions = resolved.length
    ? await dbWrite.$queryRaw<{ id: number; modelId: number }[]>`
        SELECT id, "modelId" FROM "ModelVersion" WHERE id = ANY(${resolved.map(
          (event) => event.id
        )}::int[])
      `
    : [];
  const known = new Map(versions.map((version) => [version.id, version.modelId]));
  const acted = resolved.filter((event) => known.has(event.id));

  await setLoaded(
    acted.filter((event) => event.loaded).map((event) => event.id),
    true
  );
  await setLoaded(
    acted.filter((event) => !event.loaded).map((event) => event.id),
    false
  );

  // After the writes, for the reason the sync job gives: a models sync draining the queue mid-write
  // would index the old value.
  const modelIds = uniq(
    acted.map((event) => known.get(event.id)).filter((id): id is number => !!id)
  );
  if (modelIds.length)
    await modelsSearchIndex.queueUpdate(
      modelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );

  logToAxiom({
    name: 'resource-availability-webhook',
    type: 'info',
    events: parsed.data.events.length,
    acted: acted.length,
    queued: modelIds.length,
  }).catch(() => undefined);

  return res.status(200).json({ events: parsed.data.events.length, acted: acted.length });
}
