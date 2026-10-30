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
 * SQL fragment dropping a comment notification when the recipient has muted the comment's topic, or
 * any comment above it.
 *
 * The section mute arrives as a `CommentTopicMute` row on the entity, the per-comment mute as a
 * `CommentMute` row on the comment whose replies it silences (both mirrored from `ThreadMute` until
 * the toggles move to v3). Ancestry is `path`, so "any comment above it" is one containment test; a
 * depth-clamped reply answers through `replyToId` a comment off its path, so that is checked too.
 *
 * Applied to every processor that can emit for a comment EXCEPT `new-mention` and the three
 * model-page processors (`MODEL_ONLY` in `no-unmuteable-comment-processor`). Being named is not
 * "somebody responded in a thread you're in" — Justin's call, 2026-08-27. That exemption is safe
 * against the batching rather than in spite of it: the family dedupes by `commentDedupeKey` and runs
 * in priority order, Mention first, so a mention in a muted thread claims the key and the suppressed
 * notifications cannot re-emerge behind it. A processor that omits this filter by mistake does the
 * same thing in reverse — it claims the key and replaces the notification that was suppressed.
 * `no-unmuteable-comment-processor` pins both directions.
 *
 * `alias` names the CommentV3 row the notification is about.
 */
export const notCommentMuted = (recipient: string, alias: string) => `(NOT EXISTS (
            SELECT 1 FROM "CommentTopicMute" ctm
            WHERE ctm."userId" = ${recipient}
              AND ctm."entityType" = ${alias}."entityType" AND ctm."entityId" = ${alias}."entityId"
          ) AND NOT EXISTS (
            SELECT 1 FROM "CommentMute" cm
            JOIN "CommentV3" anc ON anc.id = cm."commentId"
            WHERE cm."userId" = ${recipient}
              AND anc.id <> ${alias}.id
              AND (anc.path @> ${alias}.path OR anc.id = ${alias}."replyToId")
          ))`;

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
   * joining that table (`cosmetic-shop-item-added-to-section` and `sticker-placement-auto-accepted`) — pairing it with the
   * usual `NOT EXISTS` clause ships the notification ON while the UI renders it OFF.
   *
   * Read by the toggle handler, not just the UI, so a row is never written with the wrong polarity.
   * Opt-in types are excluded from the bulk on/off toggles: those pass a raw type list, and an INSERT
   * meant as "off" would subscribe the user instead.
   */
  optIn?: boolean;
  /** Type sent by another app (today `apps/knights`, `/api/jobs/notify`) through the notifications client's bulk path, which does no settings lookup: that sender applies the settings rows itself, with the polarity `optIn` gives. The processor has no `prepareQuery`, and nothing here may call `createNotification` for it. */
  externalProducer?: boolean;
  /** Groups this type under its own heading in notification settings. The notification itself keeps `category`. */
  section?: string;
  showCategory?: boolean;
  /** Push on for a user who never chose; see DEFAULT_PUSH_TYPES. */
  defaultPush?: boolean;
  /**
   * The type sends email, on unless the user opts out. Must match `emailNotificationTypes` in
   * `@civitai/notifications`, which the fan-out worker gates on.
   */
  defaultEmail?: boolean;
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
  /**
   * Read once per job run by the server-only runner and passed in, because the processor
   * files are in the client graph and cannot import the reader.
   *
   * Required but nullable, not optional: the reaction milestones default a missing list to
   * `[]`, so a caller that simply omitted the key would ship every milestone unfiltered
   * without a sound. Required, `tsc` rejects any new caller that forgets it; nullable, a
   * test can still say `undefined` on purpose.
   */
  excludedUserIds: number[] | undefined;
};

export function createNotificationProcessor(processor: Record<string, NotificationProcessor>) {
  return processor;
}
