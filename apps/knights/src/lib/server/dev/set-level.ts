import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { applyRankUp } from '../progression/progression';
import { expForLevel } from '../progression/levels';

export type SetLevelResult =
  | { ok: true; exp: number; rank: string }
  | { ok: false; reason: 'no-player' | 'bad-level' };

/** Dev only: puts the player at the start of a level, then applies the rank-up that level and their recorded accuracy earn. */
export async function setPlayerLevel(
  db: Kysely<DB>,
  userId: number,
  level: number
): Promise<SetLevelResult> {
  if (!Number.isInteger(level) || level < 1) return { ok: false, reason: 'bad-level' };
  const exp = expForLevel(level);
  return db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('NewOrderPlayer')
      .set({ exp })
      .where('userId', '=', userId)
      .returning('rankType')
      .executeTakeFirst();
    if (!updated) return { ok: false, reason: 'no-player' } as const;
    const promoted = await applyRankUp(trx, userId);
    return { ok: true, exp, rank: promoted ?? updated.rankType } as const;
  });
}
