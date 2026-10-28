import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { applyRankUp } from '../progression/progression';
import { expForLevel, MAX_LEVEL } from '../progression/levels';

export type SetLevelResult =
  | { ok: true; exp: number; rank: string }
  | { ok: false; reason: 'no-player' | 'bad-level' };

/** Dev only: puts the player at the start of a level, then applies the rank-up that level and their recorded accuracy earn. */
export async function setPlayerLevel(
  db: Kysely<DB>,
  userId: number,
  level: number,
  forgetLegacyExp?: (playerId: number) => Promise<void>
): Promise<SetLevelResult> {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    return { ok: false, reason: 'bad-level' };
  }
  const exp = expForLevel(level);
  const result = await db.transaction().execute(async (trx) => {
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
  // The original game's counter would otherwise win at its nightly reset and undo the level.
  if (result.ok) {
    await forgetLegacyExp?.(userId).catch((error) =>
      console.error('knights: could not clear the original game exp counter', { userId, error })
    );
  }
  return result;
}
