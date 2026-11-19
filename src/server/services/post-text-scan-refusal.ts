import { sql } from 'kysely';
import { kyselyWrite } from '~/server/db/kyselyDb';

/**
 * The text scan's refusal of a storyline text, beside a moderator's (`refusedByModerator`): with no
 * moderator refusal it is `refused`; under one, `refused` is the moderator's and the scan's verdict
 * is kept in `refusedByScan` for a restore to put back. Each verdict is one statement, so a
 * moderator's refuse or restore reads the row either before it or after it, never halfway.
 * `updatedAt` is left alone: it is when the words last changed.
 */
export async function scanRefusePostText(id: number) {
  await kyselyWrite
    .updateTable('PostText as t')
    .set({
      refused: true,
      refusedByScan: sql`t."refusedByModerator" OR t."refusedByScan"`,
      updatedAt: sql`t."updatedAt"`,
    })
    .where('t.id', '=', id)
    .where(sql<boolean>`(NOT t.refused OR (t."refusedByModerator" AND NOT t."refusedByScan"))`)
    .execute();
}

/** A clean verdict on the words the text still has (`content`): never lifts a moderator's refusal. */
export async function scanLiftPostText(id: number, content: string) {
  await kyselyWrite
    .updateTable('PostText as t')
    .set({
      refused: sql`t."refusedByModerator"`,
      refusedByScan: false,
      updatedAt: sql`t."updatedAt"`,
    })
    .where('t.id', '=', id)
    .where('t.content', '=', content)
    .where(
      sql<boolean>`((t.refused AND NOT t."refusedByModerator") OR (t."refusedByModerator" AND t."refusedByScan"))`
    )
    .execute();
}
