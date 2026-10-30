import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

const SET_ASIDE_TABLE = 'CsamQueueSetAside';

/** The review flag the CSAM queue reads. A block keeps it, so the queue lists Blocked images too. */
const CSAM_REVIEW_FLAG = 'csam';
const CSAM_QUEUE_INGESTION = ['Scanned', 'Blocked'] as const;

/** Whether set-aside rows can be read (`table`) and written (`writable`): the table exists and this
 *  role may. A row that cannot be read never counts, so the queue shows the image. */
export type SetAsideState = { table: boolean; writable: boolean };

export async function setAsideState(db: Kysely<DB>): Promise<SetAsideState> {
  const table = sql`to_regclass(${`"${SET_ASIDE_TABLE}"`})`;
  // A dismissal inserts and reads back what it inserted, so writing takes both.
  const { rows } = await sql<{ table: boolean | null; writable: boolean | null }>`
    SELECT has_table_privilege(${table}, 'SELECT') AS table,
      has_table_privilege(${table}, 'SELECT') AND has_table_privilege(${table}, 'INSERT') AS writable`.execute(
    db
  );
  return { table: rows[0]?.table === true, writable: rows[0]?.writable === true };
}

/**
 * The image (`image` is the table or alias it is read as) was dismissed and is still removed. False
 * when `state` has no table.
 */
export function setAsideCounts(image: string, state: SetAsideState) {
  if (!state.table) return sql<boolean>`false`;
  const col = (name: string) => sql.ref(`${image}.${name}`);
  return sql<boolean>`(${col('ingestion')} = 'Blocked' and exists (
    select 1
    from "CsamQueueSetAside" s
    where s."imageId" = ${col('id')}
      and s.outcome = 'Dismissed'
  ))`;
}

/** A CSAM-queue image listed as `{ id }` in a sent image report on its owner, unless that send
 *  recorded it as missing. The send reads only `{ id }` entries. `image` is the table or alias the
 *  image row is read as. */
export function listedInSentImageReport(image: string) {
  const col = (name: string) => sql.ref(`${image}.${name}`);
  return sql<boolean>`exists (
    select 1
    from "CsamReport" r
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(r.images) = 'array' then r.images else '[]'::jsonb end
    ) e
    where r."userId" = ${col('userId')}
      and r."reportSentAt" is not null
      and r.type = 'Image'
      and e ->> 'id' = ${col('id')}::text
      and not exists (
        select 1
        from jsonb_array_elements(
          case when jsonb_typeof(r.details -> 'images') = 'array' then r.details -> 'images'
          else '[]'::jsonb end
        ) d
        where d ->> 'id' = ${col('id')}::text
          and d ->> 'source' = 'missing'
      )
  )`;
}

/** Out of the CSAM queue's pending count: covered by a sent report, or set aside. */
export function outOfCsamQueuePending(image: string, setAside: SetAsideState) {
  return sql<boolean>`(${listedInSentImageReport(image)} or ${setAsideCounts(image, setAside)})`;
}

/** Listed as `{ id }` in any CSAM report on the image's owner, sent or not, whatever its send
 *  recorded: a moderator already chose to report it. */
function listedInAnyCsamReport(image: string) {
  const col = (name: string) => sql.ref(`${image}.${name}`);
  return sql<boolean>`exists (
    select 1
    from "CsamReport" r
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(r.images) = 'array' then r.images else '[]'::jsonb end
    ) e
    where r."userId" = ${col('userId')}
      and e ->> 'id' = ${col('id')}::text
  )`;
}

/**
 * The user's images still pending in the CSAM queue that no report lists, apart from `filing`: what
 * a supplemental report on the user leaves unreviewed. `viewed` is whether a moderator was shown the
 * image (a `ModActivity` row with one of `shownActivities`), which makes it reviewed but undecided.
 */
export async function getCsamSupplementalCandidates(
  db: Kysely<DB>,
  {
    userId,
    filing,
    shownActivities,
  }: { userId: number; filing: number[]; shownActivities: readonly string[] }
): Promise<{ id: number; viewed: boolean }[]> {
  const setAside = await setAsideState(db);
  const rows = await db
    .selectFrom('Image as i')
    .select([
      'i.id',
      sql<boolean>`exists (
        select 1 from "ModActivity" m
        where m."entityType" = 'image'
          and m."entityId" = i.id
          and m.activity in (${sql.join(shownActivities)})
      )`.as('viewed'),
    ])
    .where('i.userId', '=', userId)
    .where('i.needsReview', '=', CSAM_REVIEW_FLAG)
    .where('i.ingestion', 'in', CSAM_QUEUE_INGESTION)
    .where(sql<boolean>`not ${outOfCsamQueuePending('i', setAside)}`)
    .where(sql<boolean>`not ${listedInAnyCsamReport('i')}`)
    .$if(filing.length > 0, (q) => q.where('i.id', 'not in', filing))
    .orderBy('i.id')
    .execute();
  return rows.map((row) => ({ id: row.id, viewed: row.viewed === true }));
}
