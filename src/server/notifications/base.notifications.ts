import * as z from 'zod';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import type { NotificationCategory } from '~/server/common/enums';
import { MAX_THREAD_CHAIN_DEPTH } from '~/server/common/thread-chain';

/**
 * SQL fragment dropping a notification when recipient and acting user are on either side of a block.
 *
 * Both directions, because a block should stop the pair being pushed at each other whoever set it:
 * the blocker doesn't want to hear from them, and the blocked user shouldn't keep being pulled back
 * toward someone who blocked them. `Hide` counts only in the recipient's own direction — it is a
 * one-way "don't show me this person", not a mutual break.
 *
 * Needed even where a write guard already refuses the interaction: a mention or a follow reaches the
 * recipient from content the blocker never had to touch, and a follow predates the block that
 * followed it. Both arguments are SQL expressions and must be in scope where this lands.
 *
 * Both directions are exact `UserEngagement` primary-key lookups, which is what keeps this cheap —
 * see the measurements in `docs/creator-tools-backlog.md`. Splitting it into two `NOT EXISTS`
 * clauses is 2.5x SLOWER: the planner picks a secondary index for one side and reads ~47 rows per
 * candidate instead of one.
 */
export const notBlockedBetween = (recipient: string, actor: string) => `NOT EXISTS (
            SELECT 1 FROM "UserEngagement" blk
            WHERE (blk."userId" = ${recipient} AND blk."targetUserId" = ${actor} AND blk.type IN ('Block', 'Hide'))
               OR (blk."userId" = ${actor} AND blk."targetUserId" = ${recipient} AND blk.type = 'Block')
          )`;

/**
 * SQL fragment dropping a comment notification when the recipient has muted the thread it happened
 * in, or any thread above it.
 *
 * Matching only the comment's own thread would leave a mute set at the head of a conversation silent
 * about replies nested below it, which is the case the control is mostly used for. So this walks up.
 *
 * It climbs TWO edges, because neither alone reaches every ancestor. `Thread.parentThreadId` is
 * written from request input, so `throwIfThreadChainLocked` refuses to decide on it — but it is the
 * only link left once a parent comment is deleted, since `Thread.commentId` is `onDelete: SetNull`.
 * Measured on production 2026-08-27: 1,508 of 461,725 comment-anchored threads (0.33%) have no usable
 * `parentThreadId`, and 3,110 of 254,368 orphans (1.2%) have no `commentId` and only a
 * `parentThreadId`. `UNION` rather than `UNION ALL` so a diamond or a corrupted cycle converges.
 * The second edge is a scalar subquery rather than a `LEFT JOIN` so these statements stay free of one:
 * `comment.bounty-entry-owner.test.ts` refuses any `LEFT JOIN` in them, and that guard predates this.
 *
 * The 8 entity-owner processors pin `t` to the entity ROOT thread (`t."imageId" IS NOT NULL` and its
 * siblings) and this only climbs, so a mute set on a conversation under a comment never matches them.
 * Only `toggleSectionMute` writes against a root thread, and it is what makes those 8 reachable —
 * before it existed the clause on them could not match anything. `new-3d-model-comment-nested` pins
 * `t."commentId"` instead, which is why it was reachable from the per-comment control all along.
 *
 * Applied to every processor that can emit for a `CommentV2` EXCEPT `new-mention`. Being named is not
 * "somebody responded in a thread you're in" — Justin's call, 2026-08-27. That exemption is safe
 * against the batching rather than in spite of it: the family dedupes by `commentDedupeKey` and runs
 * in priority order, Mention first, so a mention in a muted thread claims the key and the suppressed
 * notifications cannot re-emerge behind it. A processor that omits this filter by mistake does the
 * same thing in reverse — it claims the key and replaces the notification that was suppressed.
 * `no-unmuteable-comment-processor` pins both directions.
 *
 * A NULL threadId yields no ancestors and passes: the legacy `Comment` branches have no thread.
 */
export const notThreadMuted = (recipient: string, threadId: string) => `NOT EXISTS (
            WITH RECURSIVE muteable_threads AS (
              SELECT ${threadId} "id", 0 "depth"
              UNION
              SELECT "parentId", mt."depth" + 1
              FROM muteable_threads mt
              JOIN "Thread" th ON th.id = mt."id"
              CROSS JOIN LATERAL unnest(ARRAY[
                th."parentThreadId",
                (SELECT pc."threadId" FROM "CommentV2" pc WHERE pc.id = th."commentId")
              ]) AS "parentId"
              WHERE "parentId" IS NOT NULL AND mt."depth" < ${MAX_THREAD_CHAIN_DEPTH}
            )
            SELECT 1
            FROM muteable_threads mt
            JOIN "ThreadMute" tm ON tm."threadId" = mt."id"
            WHERE tm."userId" = ${recipient}
          )`;

export type NotificationProcessor = {
  displayName: string;
  priority?: number;
  toggleable?: boolean;
  prepareQuery?: (input: NotificationProcessorRunInput) => Promise<string | undefined> | string;
  prepareMessage: (notification: Omit<BareNotification, 'id'>) => NotificationMessage | undefined;
  getDetails?: (notifications: BareNotification[]) => BareNotification[];
  category: NotificationCategory;
  /**
   * Inverts what a `UserNotificationSettings` row MEANS for this type: subscribed, rather than the
   * global default of opted-out. A processor may only set this if its query derives recipients by
   * joining that table (`cosmetic-shop-item-added-to-section` is the only one) — pairing it with the
   * usual `NOT EXISTS` clause ships the notification ON while the UI renders it OFF.
   *
   * Read by the toggle handler, not just the UI, so a row is never written with the wrong polarity.
   * Opt-in types are excluded from the bulk on/off toggles: those pass a raw type list, and an INSERT
   * meant as "off" would subscribe the user instead.
   */
  optIn?: boolean;
  showCategory?: boolean;
};

export const bareNotification = z.object({
  id: z.number(),
  type: z.string(),
  details: z.record(z.string(), z.any()),
});
export type BareNotification = z.infer<typeof bareNotification>;

type NotificationMessage = {
  message: string;
  url?: string;
  target?: '_blank' | '_self';
};
export type NotificationProcessorRunInput = {
  lastSent: string;
  lastSentDate: Date;
  clickhouse: CustomClickHouseClient | undefined;
};

export function createNotificationProcessor(processor: Record<string, NotificationProcessor>) {
  return processor;
}
