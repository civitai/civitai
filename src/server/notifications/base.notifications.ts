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
