import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

export function deleteCommentReactionForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('CommentReaction').where('userId', '=', userId).execute();
}
export function deleteCommentV2ReactionForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('CommentV2Reaction').where('userId', '=', userId).execute();
}
export function deleteCommentV2ForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('CommentV2').where('userId', '=', userId).execute();
}
export function deleteCommentForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('Comment').where('userId', '=', userId).execute();
}
