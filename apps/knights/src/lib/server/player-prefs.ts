import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { ensureKeeper } from './daily/daily.service';
import { utcDay } from './daily/days';

type Executor = Kysely<DB> | Transaction<DB>;

export type PlayerPrefs = {
  /** Whether yes/no questions may be served to this player. */
  yesNo: boolean;
};

/**
 * What the player chose in Knights settings, falling back to `playerDefault` (the Config page's) while they have not chosen.
 * A failed read serves no yes/no question rather than one the player may have turned off.
 */
export async function playerPrefs(
  db: Executor,
  playerId: number,
  playerDefault: boolean
): Promise<PlayerPrefs> {
  try {
    const row = await db
      .selectFrom('KnightsPlayer')
      .select('yesNoQuestions')
      .where('playerId', '=', playerId)
      .executeTakeFirst();
    return { yesNo: row?.yesNoQuestions ?? playerDefault };
  } catch (error) {
    console.error('knights: could not read the player settings', { playerId, error });
    return { yesNo: false };
  }
}

export async function setYesNoQuestions(
  db: Kysely<DB>,
  playerId: number,
  on: boolean,
  now: Date
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await ensureKeeper(trx, playerId, utcDay(now));
    await trx
      .updateTable('KnightsPlayer')
      .set({ yesNoQuestions: on })
      .where('playerId', '=', playerId)
      .execute();
  });
}

/** The preset tag groups the player hides, by key; none without a `KnightsPlayer` row. */
export async function hiddenTagGroups(db: Executor, playerId: number): Promise<string[]> {
  const row = await db
    .selectFrom('KnightsPlayer')
    .select('hiddenTagGroups')
    .where('playerId', '=', playerId)
    .executeTakeFirst();
  return row?.hiddenTagGroups ?? [];
}

/** Hides or shows one preset group for the player; sending the same choice again changes nothing. */
export async function setTagGroupHidden(
  db: Kysely<DB>,
  playerId: number,
  key: string,
  hidden: boolean,
  now: Date
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await ensureKeeper(trx, playerId, utcDay(now));
    await trx
      .updateTable('KnightsPlayer')
      .set({
        hiddenTagGroups: hidden
          ? sql<string[]>`CASE WHEN ${key} = ANY("hiddenTagGroups") THEN "hiddenTagGroups"
              ELSE array_append("hiddenTagGroups", ${key}) END`
          : sql<string[]>`array_remove("hiddenTagGroups", ${key})`,
      })
      .where('playerId', '=', playerId)
      .execute();
  });
}
