import type { Kysely, Transaction } from 'kysely';
import { sql } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  challengeDerivedNsfwLevel,
  ratedEntityContentNsfwLevelText,
  type DerivedNsfwEntityType,
} from '@civitai/shared/rated-entity-sql';

export async function computeRatedEntityDerivedNsfwLevel(
  db: Kysely<DB> | Transaction<DB>,
  entityType: DerivedNsfwEntityType | 'Challenge',
  entityId: number
): Promise<number | null> {
  if (entityType === 'Challenge') {
    const row = await db
      .selectFrom('Challenge')
      .select('allowedNsfwLevel')
      .where('id', '=', entityId)
      .executeTakeFirst();
    return row ? challengeDerivedNsfwLevel(row.allowedNsfwLevel) : null;
  }
  const result = await sql<{ derived: number }>`
    SELECT ${sql.raw(ratedEntityContentNsfwLevelText(entityType, 'e'))} AS derived
    FROM ${sql.table(entityType)} e
    WHERE e.id = ${entityId}
  `.execute(db);
  return result.rows[0]?.derived ?? null;
}
