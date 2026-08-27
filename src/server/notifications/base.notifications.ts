import * as z from 'zod';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import type { NotificationCategory } from '~/server/common/enums';

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
 * in, or ANY thread above it. Comment threads nest to 10 levels on the widest surfaces, so matching
 * only the comment's own thread and its root would leave a mute set at level 3 silent about a reply
 * at level 5 — the exact "make sure they can do this at any level" case.
 *
 * The walk is up the `parentThreadId` chain by primary key, capped so a corrupted cycle cannot spin.
 * `throwIfThreadChainLocked` walks the same chain the same way on the write path.
 *
 * Must be applied to EVERY processor that can emit for a `CommentV2` except `new-mention`, which is
 * deliberately exempt — being named is not "somebody responded in a thread you're in". The comment
 * family dedupes by `commentDedupeKey` and runs in priority batches, so a processor that wrongly
 * omits this doesn't merely leak its own notification: it CLAIMS the dedupe key and replaces the one
 * that was correctly suppressed. `no-unmuteable-comment-processor` pins both halves.
 *
 * A NULL `threadId` yields no ancestors and passes: the legacy `Comment` branches have no thread to
 * mute and are out of scope by design.
 */
export const notThreadMuted = (recipient: string, threadId: string) => `NOT EXISTS (
            WITH RECURSIVE muteable_threads AS (
              SELECT ${threadId} "id", 0 "depth"
              UNION ALL
              SELECT th."parentThreadId", mt."depth" + 1
              FROM muteable_threads mt
              JOIN "Thread" th ON th.id = mt."id"
              WHERE th."parentThreadId" IS NOT NULL AND mt."depth" < 20
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
