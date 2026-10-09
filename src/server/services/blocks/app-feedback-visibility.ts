import { APP_BLOCK_FEEDBACK_AREA } from '~/shared/constants/feedback.constants';

/**
 * The ONE SQL statement of which app feedback a listing's developer may see, shared by every raw
 * read of it: the owner inbox list and New counts (`app-feedback.service.ts`) and the owner digest
 * (`app-feedback.notifications.ts`). Aliases: `f` = "Feedback", `u` = the reporter's "User".
 *
 * Plain SQL text, not `Prisma.Sql`, because the notification runner takes a raw string; the
 * service wraps it in `Prisma.raw`. Every value in it is a code constant, never input.
 *
 * Scoping to a listing is NOT here: the inbox binds the seat listing's id, while the digest joins
 * every listing. The Prisma write paths use `ownerVisibleWhere`, which must say the same thing.
 */
export const OWNER_VISIBLE_FEEDBACK_SQL = [
  `f.area = '${APP_BLOCK_FEEDBACK_AREA}'`,
  // A moderator's "Hide from developer".
  `f."hiddenFromOwnerAt" IS NULL`,
  // A reporter banned since they wrote it.
  `u."bannedAt" IS NULL`,
].join(' AND ');

/** "New" to the developer: no owner status yet. The inbox's New filter and the digest's count. */
export const OWNER_NEW_FEEDBACK_SQL = `f."ownerStatus" IS NULL`;
