import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

export function deleteChatMessageForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('ChatMessage').where('userId', '=', userId).execute();
}
export function deleteChatMemberForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('ChatMember').where('userId', '=', userId).execute();
}
