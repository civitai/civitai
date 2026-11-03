import { fail } from '@sveltejs/kit';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

export type Standing = { banned: boolean; muted: boolean };

export const MUTED_MESSAGE =
  "Your account is muted, so you can't judge right now. You can still view your record and your gold.";

/**
 * The account's standing, read from the User row at the moment of asking: the session can be stale, so a ban or
 * a mute decision never comes from it. A deleted account counts as banned. One primary-key lookup.
 */
export async function getStanding(db: Kysely<DB>, userId: number): Promise<Standing> {
  const row = await db
    .selectFrom('User')
    .select(['bannedAt', 'deletedAt', 'muted'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return {
    banned: row !== undefined && (row.bannedAt !== null || row.deletedAt !== null),
    muted: row?.muted === true,
  };
}

/** The refusal every judging action answers a muted player with. `extra` rides along for the page to key on. */
export const mutedFailure = (extra: Record<string, unknown> = {}) =>
  fail(403, { message: MUTED_MESSAGE, muted: true, ...extra });
