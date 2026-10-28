import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

/** Settles every still-pending vote on an item against the answer it was finally decided as. */
export async function gradeKnightsVotes(
  db: Kysely<DB> | Transaction<DB>,
  itemId: number,
  correctAnswer: string
) {
  await db
    .updateTable('KnightsVote')
    .set({
      verdict: sql<string>`CASE WHEN "answer" = ${correctAnswer} THEN 'correct' ELSE 'failed' END`,
    })
    .where('itemId', '=', itemId)
    .where('verdict', '=', 'pending')
    .execute();
}
