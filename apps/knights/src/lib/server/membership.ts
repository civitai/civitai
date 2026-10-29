import { redirect } from '@sveltejs/kit';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getPlayerStatus, type PlayerStatus } from './player-status';

/** The player's status, or a redirect to the front page, where a user joins, if they have no player row. */
export async function requireMember(db: Kysely<DB>, userId: number): Promise<PlayerStatus> {
  const status = await getPlayerStatus(db, userId);
  if (!status) redirect(303, '/');
  return status;
}
