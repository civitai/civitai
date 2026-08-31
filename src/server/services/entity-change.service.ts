import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';

export type EntityChangeHistoryRow = {
  createdAt: string;
  userId: number;
  entityType: string;
  entityId: number;
  field: string;
  oldValue: string;
  newValue: string;
  truncated: number;
  actorRole: string;
  via: string;
  reason: string;
  batchId: string;
};

// Mod-facing change history for one model: its own rows plus its versions' and
// files' (docs/entity-change-tracking-plan.md). Each OR branch is a primary-key
// prefix range of entityChangeEvents, so cost tracks the model's history, not
// table size. All interpolated values are DB/zod-sourced integers — $query does
// not escape strings.
export async function getModelChangeHistory({
  modelId,
  limit = 100,
}: {
  modelId: number;
  limit?: number;
}) {
  const empty = {
    items: [] as EntityChangeHistoryRow[],
    usernames: {} as Record<number, string | null>,
    entityLabels: {} as Record<string, string>,
  };
  if (!clickhouse) return empty;

  const versions = await dbRead.modelVersion.findMany({
    where: { modelId },
    select: { id: true, name: true, files: { select: { id: true, name: true } } },
  });
  const versionIds = versions.map((v) => v.id);
  const fileIds = versions.flatMap((v) => v.files.map((f) => f.id));

  const clauses = [`(entityType = 'Model' AND entityId = ${modelId})`];
  if (versionIds.length)
    clauses.push(`(entityType = 'ModelVersion' AND entityId IN (${versionIds.join(',')}))`);
  if (fileIds.length)
    clauses.push(`(entityType = 'ModelFile' AND entityId IN (${fileIds.join(',')}))`);

  const items = await clickhouse.$query<EntityChangeHistoryRow>(`
    SELECT createdAt, userId, entityType, entityId, field, oldValue, newValue,
           truncated, actorRole, via, reason, batchId
    FROM entityChangeEvents
    WHERE ${clauses.join(' OR ')}
    ORDER BY createdAt DESC
    LIMIT ${Math.min(limit, 500)}
  `);

  const userIds = [...new Set(items.map((r) => r.userId).filter((id) => id > 0))];
  const users = userIds.length
    ? await dbRead.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true },
      })
    : [];

  const entityLabels: Record<string, string> = {};
  for (const v of versions) {
    entityLabels[`ModelVersion:${v.id}`] = v.name;
    for (const f of v.files) entityLabels[`ModelFile:${f.id}`] = `${v.name} · ${f.name}`;
  }

  return {
    items,
    usernames: Object.fromEntries(users.map((u) => [u.id, u.username])),
    entityLabels,
  };
}
