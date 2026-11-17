import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import {
  PERMISSION_FIELDS as FIELDS,
  modelEventsQuery,
  modelIdsQuery,
} from '~/server/utils/model-permission-backfill-queries';
import type {
  ModelPermissions,
  PermissionChangeEvent,
} from '~/server/utils/model-permission-snapshot';
import {
  reconstructPermissionSnapshots,
  stateAtCutover,
} from '~/server/utils/model-permission-snapshot';
import { booleanString } from '~/utils/zod-helpers';

/**
 * One-off, for migration `20261027120000_model_permission_snapshot`: rebuilds ModelPermissionSnapshot
 * history for every model whose permissions changed in the ClickHouse entity-change log, so merges made
 * before upsertModel began writing snapshots can be judged by the permission then in effect.
 *
 * Run after the migration and the deploy. Rebuilds events before `before`, which defaults to the
 * first live snapshot, i.e. when the deploy started writing them; later changes already have live
 * rows. Per model it replaces every 'baseline' and 'backfill' row and never touches a 'live' one, so
 * it can be re-run. A live baseline (the state a model left on its first live change) is replaced by
 * the one rebuilt here, which knows about the changes logged before it.
 *
 * Models with no logged change get no rows: having none means "held its current permissions since
 * it was created or the log began".
 *
 *   ?dryRun=true|false   (default true; a live run must be POSTed)
 *   &batchSize=500       models per batch
 *   &afterId=0           resume from the previous response's `lastId`
 *   &before=<ISO date>   override the cutover
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(2000).default(500),
  afterId: z.coerce.number().min(0).default(0),
  before: z.coerce.date().optional(),
});

type EventRow = {
  entityId: number;
  createdAt: string;
  field: (typeof FIELDS)[number];
  oldValue: string;
  newValue: string;
  userId: number;
  actorRole: string;
};

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);
  if (!params.dryRun && req.method !== 'POST')
    return res.status(405).json({ error: 'A live run must be POSTed' });
  if (!clickhouse) return res.status(500).json({ error: 'ClickHouse is not configured' });

  const firstLive = await dbRead.modelPermissionSnapshot.findFirst({
    where: { source: 'live' },
    orderBy: { effectiveAt: 'asc' },
    select: { effectiveAt: true },
  });
  const before = params.before ?? firstLive?.effectiveAt ?? new Date();

  const ids = (
    await (
      await clickhouse.query({
        ...modelIdsQuery({ before, afterId: params.afterId, batchSize: params.batchSize }),
        format: 'JSONEachRow',
      })
    ).json<{ entityId: number }>()
  ).map((r) => Number(r.entityId));
  if (!ids.length) return res.status(200).json({ done: true, before });

  // Every event, not only those before the cutover: a field's first change AFTER it says, through its
  // oldValue, what the field held at the cutover, which today's value cannot once it has moved again.
  const events = await (
    await clickhouse.query({ ...modelEventsQuery(ids), format: 'JSONEachRow' })
  ).json<EventRow>();

  const models = (await dbRead.model.findMany({
    where: { id: { in: ids } },
    select: { id: true, createdAt: true, ...Object.fromEntries(FIELDS.map((f) => [f, true])) },
  })) as (ModelPermissions & { id: number; createdAt: Date })[];

  const eventsByModel = new Map<number, PermissionChangeEvent[]>();
  for (const e of events) {
    const list = eventsByModel.get(Number(e.entityId)) ?? [];
    list.push({
      // ClickHouse DateTime64 strings are UTC without a zone marker.
      createdAt: new Date(e.createdAt.replace(' ', 'T') + 'Z'),
      field: e.field,
      oldValue: e.oldValue,
      newValue: e.newValue,
      userId: e.userId ? Number(e.userId) : null,
      actorRole: e.actorRole || null,
    });
    eventsByModel.set(Number(e.entityId), list);
  }

  let written = 0;
  for (const model of models) {
    const all = eventsByModel.get(model.id) ?? [];
    const rows = reconstructPermissionSnapshots({
      modelId: model.id,
      modelCreatedAt: model.createdAt,
      events: all.filter((e) => e.createdAt < before),
      stateAtEnd: stateAtCutover(
        model,
        all.filter((e) => e.createdAt >= before)
      ),
    });
    written += rows.length;
    if (params.dryRun || !rows.length) continue;
    await dbWrite.$transaction([
      dbWrite.modelPermissionSnapshot.deleteMany({
        where: { modelId: model.id, source: { in: ['baseline', 'backfill'] } },
      }),
      dbWrite.modelPermissionSnapshot.createMany({ data: rows }),
    ]);
  }
  const skippedDeleted = ids.length - models.length;

  return res.status(200).json({
    dryRun: params.dryRun,
    before,
    models: models.length,
    skippedDeleted,
    rows: written,
    lastId: ids[ids.length - 1],
  });
});
