import { Prisma } from '@prisma/client';
import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbRead } from '~/server/db/client';
import {
  createSilenceCheckTypeAges,
  type SilenceCheckTypeAge,
} from '~/server/notifications/silence-check';

/** Each opt-out type with when it was first switched off; cached for an hour in this process. */
export const silenceCheckTypeAges = createSilenceCheckTypeAges({
  query: (types) =>
    dbRead.$queryRaw<{ type: string; firstSeen: Date }[]>(Prisma.sql`
      SELECT "type", min("disabledAt") AS "firstSeen"
      FROM "UserNotificationSettings"
      WHERE "type" IN (${Prisma.join(types)})
      GROUP BY "type"
    `),
});

/**
 * Of `ids`, the users who turned every notification off. The settings page writes a row only for
 * each type that exists then, so a user is judged against the types that existed at their latest
 * change: silenced means a row for each of them, and at least one row. A type added later never
 * counts against them. The same rule the Knights app applies to its players (`silencedAmong` in its
 * notify service), which reads the same type ages over HTTP.
 */
// Copy of `silencedAmong` in apps/knights/src/lib/server/notify/notify.service.ts; change both.
export async function silencedUsersAmong(
  db: Kysely<DB>,
  ids: number[],
  silenceTypes: SilenceCheckTypeAge[]
): Promise<Set<number>> {
  const silenced = new Set<number>();
  if (ids.length === 0 || silenceTypes.length === 0) return silenced;
  const types = sql.join(silenceTypes.map((t) => sql`${t.type}`));
  const known = sql.join(silenceTypes.map((t) => sql`(${t.type}, ${utc(new Date(t.firstSeen))})`));
  const rows = await sql<{ userId: number }>`
    select u."userId" from (
      select s."userId", max(s."disabledAt") as latest, array_agg(s."type") as have
      from "UserNotificationSettings" s
      where s."userId" = any(${ids}::int[]) and s."type" in (${types})
      group by s."userId"
    ) u
    where not exists (
      select 1 from (values ${known}) as known("type", "firstSeen")
      where known."firstSeen" <= u.latest and not (known."type" = any(u.have))
    )`.execute(db);
  for (const row of rows.rows) silenced.add(row.userId);
  return silenced;
}
