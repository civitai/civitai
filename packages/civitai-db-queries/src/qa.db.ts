import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

export function deleteAnswerForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('Answer').where('userId', '=', userId).execute();
}
export function deleteQuestionForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('Question').where('userId', '=', userId).execute();
}
