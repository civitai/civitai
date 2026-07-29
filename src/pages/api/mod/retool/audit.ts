/**
 * Retool-callable mod endpoints for the entity change/audit log
 * (docs/entity-change-tracking-plan.md).
 * =============================================================================
 *
 * Auth: Bearer <user API key> (mod role required).
 *
 * POST /api/mod/retool/audit
 * Body: { "action": "<action>", ...params }
 *
 * Actions:
 *   changeHistory - { entityType, entityId, limit?, cursor? }
 *                   Full change history for one entity (all actor roles),
 *                   newest first. `cursor` = createdAt of the last row from the
 *                   previous page (keyset pagination); response includes
 *                   nextCursor when more rows may exist.
 */
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { watchedEntityFields } from '~/server/common/entity-change.constants';
import { defineRetoolEndpoint, retoolAction } from '~/server/utils/retool-endpoint';

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

export default defineRetoolEndpoint('audit', {
  changeHistory: retoolAction({
    input: z.object({
      entityType: z.enum(
        Object.keys(watchedEntityFields) as [
          keyof typeof watchedEntityFields,
          ...(keyof typeof watchedEntityFields)[]
        ]
      ),
      entityId: z.coerce.number().int().positive(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      cursor: z.coerce.date().optional(),
    }),
    handler: async ({ entityType, entityId, limit, cursor }) => {
      if (!clickhouse) return { items: [], nextCursor: null };

      // Both filters are zod-validated (enum + int) and cursor interpolates as a
      // Date → parseDateTimeBestEffort — nothing user-controlled lands in the SQL
      // as a raw string. The WHERE is a prefix of the table's ORDER BY
      // (entityType, entityId, createdAt), so this is a bounded range scan.
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
  }),
});
