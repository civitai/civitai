import { env } from '$env/dynamic/private';
import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';

/** Threads whose last message is the user's, for the sidebar badge. 0 when the account is not configured. */
export async function countAwaitingReply(): Promise<number> {
  const moderationId = Number(env.CIVITAI_MODERATION_USER_ID);
  if (!(moderationId > 0)) return 0;
  const { rows } = await sql<{ count: number }>`
    SELECT count(*)::int AS count
    FROM "ChatMember" sm
    JOIN "Chat" c ON c.id = sm."chatId" AND c."isGroup" = false
    JOIN LATERAL (
      SELECT m."userId" FROM "ChatMessage" m
      WHERE m."chatId" = sm."chatId" AND m."deletedAt" IS NULL AND m."userId" <> -1
      ORDER BY m.id DESC
      LIMIT 1
    ) last ON true
    WHERE sm."userId" = ${moderationId} AND last."userId" <> ${moderationId}
  `.execute(dbRead);
  return rows[0]?.count ?? 0;
}
