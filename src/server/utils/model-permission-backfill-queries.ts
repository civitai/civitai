export const PERMISSION_FIELDS = [
  'allowNoCredit',
  'allowCommercialUse',
  'allowDerivatives',
  'allowDifferentLicense',
] as const;

// ClickHouse's `$query` template formats strings verbatim, so these ride in `query_params`.
export type BackfillQuery = { query: string; query_params: Record<string, unknown> };

const chDateTime64 = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');

export function modelIdsQuery(args: {
  before: Date;
  afterId: number;
  batchSize: number;
}): BackfillQuery {
  return {
    query: `
      SELECT DISTINCT entityId
      FROM entityChangeEvents
      WHERE entityType = 'Model' AND field IN {fields:Array(String)}
        AND createdAt < {before:DateTime64(3)} AND entityId > {afterId:UInt64}
      ORDER BY entityId
      LIMIT {batchSize:UInt32}
    `,
    query_params: {
      fields: [...PERMISSION_FIELDS],
      before: chDateTime64(args.before),
      afterId: args.afterId,
      batchSize: args.batchSize,
    },
  };
}

export function modelEventsQuery(ids: number[]): BackfillQuery {
  return {
    query: `
      SELECT entityId, createdAt, field, oldValue, newValue, userId, actorRole
      FROM entityChangeEvents
      WHERE entityType = 'Model' AND entityId IN {ids:Array(UInt64)} AND field IN {fields:Array(String)}
      ORDER BY entityId, createdAt
    `,
    query_params: { ids, fields: [...PERMISSION_FIELDS] },
  };
}
