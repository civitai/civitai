import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { watchedEntityFields } from '~/server/common/entity-change.constants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

type EntityChangeEventRow = {
  createdAt: string;
  userId: number;
  entityType: string;
  entityId: number;
  ownerId: number;
  field: string;
  oldValue: string;
  newValue: string;
  truncated: number;
  actorRole: string;
  via: string;
  reason: string;
  batchId: string;
};

export default defineModeratorEndpoint('audit.changeHistory', {
  summary: 'Every recorded change to one entity, newest first, across all actor roles.',
  returns: '{ items, nextCursor }',
  notes: [
    'Keyset pagination: pass the previous page’s `nextCursor` as `cursor`.',
    '`nextCursor` is null once a page comes back short of `limit`.',
  ],
  input: z.object({
    entityType: z
      .enum(
        Object.keys(watchedEntityFields) as [
          keyof typeof watchedEntityFields,
          ...(keyof typeof watchedEntityFields)[]
        ]
      )
      .describe('Which kind of entity to read the history of.'),
    entityId: z.coerce.number().int().positive().describe('The entity id.'),
    limit: z.coerce.number().int().min(1).max(500).default(100).describe('Rows per page.'),
    cursor: z.coerce
      .date()
      .optional()
      .describe('`createdAt` of the last row of the previous page.'),
  }),
  async handler({ entityType, entityId, limit, cursor }) {
    if (!clickhouse) return { items: [], nextCursor: null };

    // Both filters are zod-validated (enum + int) and cursor interpolates as a Date →
    // parseDateTimeBestEffort, so nothing user-controlled lands in the SQL as a raw string. The WHERE
    // is a prefix of the table's ORDER BY (entityType, entityId, createdAt): a bounded range scan.
    const items = cursor
      ? await clickhouse.$query<EntityChangeEventRow>`
          SELECT createdAt, userId, entityType, entityId, ownerId, field, oldValue,
                 newValue, truncated, actorRole, via, reason, batchId
          FROM entityChangeEvents
          WHERE entityType = '${entityType}' AND entityId = ${entityId}
            AND createdAt < ${cursor}
          ORDER BY createdAt DESC
          LIMIT ${limit}
        `
      : await clickhouse.$query<EntityChangeEventRow>`
          SELECT createdAt, userId, entityType, entityId, ownerId, field, oldValue,
                 newValue, truncated, actorRole, via, reason, batchId
          FROM entityChangeEvents
          WHERE entityType = '${entityType}' AND entityId = ${entityId}
          ORDER BY createdAt DESC
          LIMIT ${limit}
        `;

    return {
      items,
      nextCursor: items.length === limit ? items[items.length - 1].createdAt : null,
    };
  },
});
