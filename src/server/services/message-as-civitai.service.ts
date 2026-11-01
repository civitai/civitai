import { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import { getModerationAccountId } from '~/server/auth/moderation-account';
import { createHash, randomUUID } from 'crypto';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { delIfValue } from '~/server/redis/atomic';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { createMessage, upsertChat } from '~/server/services/chat.service';
import { reportConcernsUser } from '~/server/services/report-subject';
import { resolveChatIdentity } from '~/server/utils/chat-group';
import {
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
  throwRateLimitError,
  throwServiceUnavailableError,
} from '~/server/utils/errorHandling';
import { NotificationCategory } from '~/server/common/enums';
import { ChatMemberStatus, ChatMessageType } from '~/shared/utils/prisma/enums';

export const MESSAGE_AS_CIVITAI_ACTIVITY = 'message-as-civitai';
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
// Long enough for any send to finish; a crash mid-send frees the key after this rather than after a day.
const PENDING_TTL_SECONDS = 5 * 60;
const SEND_LOCK_SECONDS = 30;
const PENDING = 'pending';
// Redis runs a script atomically, so nothing can take the lock between the GET and the DEL.

function requireModerationAccountId(): number {
  const id = getModerationAccountId();
  if (id === null) throw throwServiceUnavailableError('Messaging as Civitai is not configured.');
  return id;
}

async function findThreadChatId(moderationId: number, userId: number): Promise<number | null> {
  const { hash } = resolveChatIdentity({ userIds: [moderationId, userId], isGroup: false });
  if (!hash) return null;
  const chat = await dbWrite.chat.findFirst({ where: { hash }, select: { id: true } });
  return chat?.id ?? null;
}

/**
 * Takes or renews the claim on a thread. Returns the moderator holding it afterwards: the actor on
 * success, someone else when their unexpired claim stands.
 */
export async function claimThread({
  chatId,
  moderatorId,
  retry = true,
}: {
  chatId: number;
  moderatorId: number;
  retry?: boolean;
}): Promise<{ claimed: boolean; moderatorId: number; expiresAt: Date }> {
  const [row] = await dbWrite.$queryRaw<{ moderatorId: number; expiresAt: Date }[]>`
    INSERT INTO "ModThreadClaim" ("chatId", "moderatorId", "claimedAt", "expiresAt")
    VALUES (${chatId}, ${moderatorId}, now(), now() + interval '30 minutes')
    ON CONFLICT ("chatId") DO UPDATE
      SET "moderatorId" = EXCLUDED."moderatorId",
          "claimedAt" = CASE WHEN "ModThreadClaim"."moderatorId" = EXCLUDED."moderatorId"
                             THEN "ModThreadClaim"."claimedAt" ELSE EXCLUDED."claimedAt" END,
          "expiresAt" = EXCLUDED."expiresAt"
      WHERE "ModThreadClaim"."moderatorId" = EXCLUDED."moderatorId"
         OR "ModThreadClaim"."expiresAt" <= now()
    RETURNING "moderatorId", "expiresAt"
  `;
  if (row) return { claimed: true, ...row };

  const [holder] = await dbWrite.$queryRaw<{ moderatorId: number; expiresAt: Date }[]>`
    SELECT "moderatorId", "expiresAt" FROM "ModThreadClaim" WHERE "chatId" = ${chatId}
  `;
  // The holder's claim can lapse between the two statements; a retry then takes it.
  if (!holder) {
    if (retry) return claimThread({ chatId, moderatorId, retry: false });
    throw throwConflictError('The claim on this thread changed hands; try again.');
  }
  return { claimed: false, ...holder };
}

/** Only the holder releases; an expired claim needs no release. */
export async function releaseThread({
  chatId,
  moderatorId,
}: {
  chatId: number;
  moderatorId: number;
}): Promise<boolean> {
  const count = await dbWrite.$executeRaw`
    DELETE FROM "ModThreadClaim" WHERE "chatId" = ${chatId} AND "moderatorId" = ${moderatorId}
  `;
  return count > 0;
}

/** Shared-account messages in the last 24 h that the user has not answered since. */
export async function countUnansweredMessages({
  chatId,
  moderationId,
  userId,
}: {
  chatId: number;
  moderationId: number;
  userId: number;
}): Promise<number> {
  const [row] = await dbWrite.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM "ChatMessage" m
    WHERE m."chatId" = ${chatId}
      AND m."userId" = ${moderationId}
      AND m."deletedAt" IS NULL
      AND m."createdAt" > now() - interval '24 hours'
      AND m."createdAt" > COALESCE(
        (SELECT max(r."createdAt") FROM "ChatMessage" r
         WHERE r."chatId" = ${chatId} AND r."userId" = ${userId} AND r."deletedAt" IS NULL),
        '-infinity'::timestamp
      )
  `;
  return row?.count ?? 0;
}

export type SendAsCivitaiInput = {
  actorId: number;
  userId: number;
  message: string;
  context?: { reportId?: number };
};

export async function sendAsCivitai({ actorId, userId, message, context }: SendAsCivitaiInput) {
  const moderationId = requireModerationAccountId();
  if (userId === moderationId || actorId === moderationId)
    throw throwBadRequestError('The Civitai Moderation account cannot message itself.');

  const target = await dbWrite.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, bannedAt: true },
  });
  if (!target) throw throwNotFoundError(`No user with id ${userId}`);
  if (target.bannedAt)
    throw throwBadRequestError('This account is banned; it answers through the appeal flow.');

  // One send per target at a time: the cap is a count followed by an insert, and a first message creates
  // the thread, so two concurrent sends would each pass the count or race to create it.
  const lockKey = `${REDIS_SYS_KEYS.MESSAGE_AS_CIVITAI.SEND_LOCK}:${userId}` as const;
  const owner = randomUUID();
  if ((await sysRedis.set(lockKey, owner, { NX: true, EX: SEND_LOCK_SECONDS })) === null)
    throw throwConflictError('Another message to this user is being sent; retry in a moment.');
  try {
    return await sendLocked({ actorId, userId, message, context, moderationId });
  } finally {
    // Only our own lock: a send that outlived the TTL must not free the next sender's.
    await delIfValue(sysRedis, lockKey, owner).catch(() => undefined);
  }
}

async function sendLocked({
  actorId,
  userId,
  message,
  context,
  moderationId,
}: SendAsCivitaiInput & { moderationId: number }) {
  let chatId = await findThreadChatId(moderationId, userId);
  if (chatId !== null) {
    const member = await dbWrite.chatMember.findFirst({
      where: { chatId, userId },
      select: { status: true },
    });
    if (member?.status !== ChatMemberStatus.Joined && member?.status !== ChatMemberStatus.Invited)
      throw throwBadRequestError('This user is no longer in the Civitai Moderation thread.');
    // Checked before claiming, so a refused send does not lock other moderators out of the thread.
    const unanswered = await countUnansweredMessages({ chatId, moderationId, userId });
    if (unanswered >= env.MESSAGE_AS_CIVITAI_DAILY_CAP)
      throw throwRateLimitError(
        `This user already has ${unanswered} unanswered messages from Civitai Moderation in the last 24 hours.`
      );
    await requireClaim(chatId, actorId);
  } else {
    const chat = await upsertChat({
      userIds: [userId],
      isGroup: false,
      userId: moderationId,
      isModerator: true,
    });
    chatId = chat.id;
    await requireClaim(chatId, actorId);
  }

  const sent = await createMessage({
    chatId,
    content: message,
    contentType: ChatMessageType.Markdown,
    userId: moderationId,
    isModerator: true,
  });

  // The message is already delivered, so a failed audit write must not turn into a retry that sends it
  // twice; the error log carries what is needed to write the row by hand. Two statements, so the
  // report link failing cannot take the author record with it.
  const audit = (entityType: 'chatMessage' | 'report', entityId: number) =>
    dbWrite.$executeRaw`
      INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
      VALUES (${actorId}, ${entityType}, ${MESSAGE_AS_CIVITAI_ACTIVITY}, ${entityId})
    `.catch((e: Error) =>
      logToAxiom({
        type: 'error',
        name: 'message-as-civitai-audit-failed',
        actorId,
        chatMessageId: sent.id,
        entityType,
        entityId,
        message: e.message,
      }).catch(() => undefined)
    );
  await audit('chatMessage', sent.id);
  if (context?.reportId) {
    const reportId = context.reportId;
    const concerns = await reportConcernsUser(reportId, userId).catch((e: Error) => e);
    if (concerns === true) await audit('report', reportId);
    else
      await logToAxiom({
        type: 'warning',
        name: 'message-as-civitai-report-link-dropped',
        reason: concerns === false ? 'not-about-recipient' : 'check-failed',
        error: concerns instanceof Error ? concerns.message : undefined,
        actorId,
        userId,
        reportId,
        chatMessageId: sent.id,
      }).catch(() => undefined);
  }
  // Delivered already; a failed tray notice must not free the idempotency key for a second send.
  await nudge({ userId, chatId, messageId: sent.id }).catch(() => undefined);

  return { chatId, messageId: sent.id };
}

/**
 * `sendAsCivitai`, at most once per key. Without a key, one identical message per actor, target and
 * minute, so a double submit sends once.
 */
export async function sendAsCivitaiOnce(input: SendAsCivitaiInput & { idempotencyKey?: string }) {
  // Bound to the target and the text: a reused key with a different user or edited text is a new
  // message, not a repeat of the first.
  const content = createHash('sha256')
    .update(`${input.userId}:${input.message}`)
    .digest('hex')
    .slice(0, 16);
  const scope = input.idempotencyKey
    ? `${input.idempotencyKey}:${content}`
    : `auto:${Math.floor(Date.now() / 60_000)}:${content}`;
  const key = `${REDIS_SYS_KEYS.MESSAGE_AS_CIVITAI.IDEMPOTENCY}:${input.actorId}:${scope}` as const;

  const fresh = await sysRedis.set(key, PENDING, { NX: true, EX: PENDING_TTL_SECONDS });
  if (fresh === null) {
    const stored = await sysRedis.get(key);
    if (!stored || stored === PENDING)
      throw throwConflictError('This message is already being sent; retry in a moment.');
    return { ...(JSON.parse(stored) as { chatId: number; messageId: number }), deduped: true };
  }

  let result: Awaited<ReturnType<typeof sendAsCivitai>>;
  try {
    result = await sendAsCivitai(input);
  } catch (e) {
    await sysRedis.del(key).catch(() => undefined);
    throw e;
  }
  // Sent: if storing the result fails, the pending key still refuses a retry until it lapses.
  await sysRedis
    .set(key, JSON.stringify(result), { EX: IDEMPOTENCY_TTL_SECONDS })
    .catch(() => undefined);
  return { ...result, deduped: false };
}

async function requireClaim(chatId: number, actorId: number) {
  const claim = await claimThread({ chatId, moderatorId: actorId });
  if (claim.claimed) return;
  const holder = await dbWrite.user.findFirst({
    where: { id: claim.moderatorId },
    select: { username: true },
  });
  const minutes = Math.max(1, Math.ceil((claim.expiresAt.getTime() - Date.now()) / 60_000));
  throw throwConflictError(
    `${
      holder?.username ?? 'Another moderator'
    } is answering this thread for the next ${minutes} min.`
  );
}

// Chat itself reaches nobody whose chat is off or muted, so the tray carries a pointer to the thread.
async function nudge({
  userId,
  chatId,
  messageId,
}: {
  userId: number;
  chatId: number;
  messageId: number;
}) {
  const { createNotification } = await import('~/server/services/notification.service');
  await createNotification({
    userId,
    category: NotificationCategory.System,
    type: 'system-announcement',
    key: `message-as-civitai:${messageId}`,
    details: {
      message: 'You have a new message from Civitai Moderation.',
      url: `/?chat=${chatId}`,
    },
  });
}

export type InboxThread = {
  chatId: number;
  userId: number;
  username: string | null;
  lastMessageId: number;
  lastMessageFromCivitai: boolean;
  lastMessage: string;
  lastMessageAt: Date;
  claimedBy: number | null;
  claimedByUsername: string | null;
  claimExpiresAt: Date | null;
};

/** Threads with the moderation account, oldest unanswered first. */
export async function getInbox({
  awaitingOnly = true,
  limit = 50,
}: { awaitingOnly?: boolean; limit?: number } = {}) {
  const moderationId = requireModerationAccountId();
  const awaiting = awaitingOnly ? Prisma.sql`AND last."userId" <> ${moderationId}` : Prisma.empty;
  const order = awaitingOnly ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  const threads = await dbWrite.$queryRaw<InboxThread[]>`
    SELECT c.id AS "chatId",
           u.id AS "userId",
           u.username,
           last.id AS "lastMessageId",
           last."userId" = ${moderationId} AS "lastMessageFromCivitai",
           last.content AS "lastMessage",
           last."createdAt" AS "lastMessageAt",
           cl."moderatorId" AS "claimedBy",
           cu.username AS "claimedByUsername",
           cl."expiresAt" AS "claimExpiresAt"
    FROM "ChatMember" sm
    JOIN "Chat" c ON c.id = sm."chatId" AND c."isGroup" = false
    JOIN "ChatMember" um ON um."chatId" = c.id AND um."userId" <> ${moderationId}
    JOIN "User" u ON u.id = um."userId"
    JOIN LATERAL (
      SELECT m.id, m."userId", m.content, m."createdAt"
      FROM "ChatMessage" m
      WHERE m."chatId" = c.id AND m."deletedAt" IS NULL AND m."userId" <> -1
      ORDER BY m.id DESC
      LIMIT 1
    ) last ON true
    LEFT JOIN "ModThreadClaim" cl ON cl."chatId" = c.id AND cl."expiresAt" > now()
    LEFT JOIN "User" cu ON cu.id = cl."moderatorId"
    WHERE sm."userId" = ${moderationId}
      ${awaiting}
    ORDER BY last."createdAt" ${order}
    LIMIT ${limit}
  `;
  return threads;
}

export async function getThread({ userId, limit = 200 }: { userId: number; limit?: number }) {
  const moderationId = requireModerationAccountId();
  const chatId = await findThreadChatId(moderationId, userId);
  if (chatId === null) return { chatId: null, claim: null, messages: [] };

  const [claim] = await dbWrite.$queryRaw<
    { moderatorId: number; username: string | null; expiresAt: Date }[]
  >`
    SELECT cl."moderatorId", u.username, cl."expiresAt"
    FROM "ModThreadClaim" cl
    LEFT JOIN "User" u ON u.id = cl."moderatorId"
    WHERE cl."chatId" = ${chatId} AND cl."expiresAt" > now()
  `;
  // `sentBy` is who actually wrote a Civitai Moderation message; the user only ever sees the account.
  const messages = await dbWrite.$queryRaw<
    {
      id: number;
      userId: number;
      fromCivitai: boolean;
      content: string;
      contentType: string;
      createdAt: Date;
      sentById: number | null;
      sentByUsername: string | null;
    }[]
  >`
    SELECT m.id, m."userId", m."userId" = ${moderationId} AS "fromCivitai", m.content,
           m."contentType"::text AS "contentType", m."createdAt",
           a."userId" AS "sentById", mu.username AS "sentByUsername"
    FROM "ChatMessage" m
    LEFT JOIN LATERAL (
      SELECT ma."userId" FROM "ModActivity" ma
      WHERE ma."entityType" = 'chatMessage' AND ma.activity = ${MESSAGE_AS_CIVITAI_ACTIVITY}
        AND ma."entityId" = m.id
      ORDER BY ma.id
      LIMIT 1
    ) a ON m."userId" = ${moderationId}
    LEFT JOIN "User" mu ON mu.id = a."userId"
    WHERE m."chatId" = ${chatId} AND m."deletedAt" IS NULL AND m."userId" <> -1
    ORDER BY m.id DESC
    LIMIT ${limit}
  `;
  return { chatId, claim: claim ?? null, messages: messages.reverse() };
}

export async function getThreadChatIdForUser(userId: number) {
  return findThreadChatId(requireModerationAccountId(), userId);
}

/** messageId -> username of the moderator who sent it as Civitai Moderation. */
export async function getMessageAuthors(messageIds: number[]): Promise<Record<number, string>> {
  if (!messageIds.length) return {};
  const rows = await dbWrite.$queryRaw<{ messageId: number; username: string | null }[]>`
    SELECT DISTINCT ON (ma."entityId") ma."entityId" AS "messageId", u.username
    FROM "ModActivity" ma
    LEFT JOIN "User" u ON u.id = ma."userId"
    WHERE ma."entityType" = 'chatMessage' AND ma.activity = ${MESSAGE_AS_CIVITAI_ACTIVITY}
      AND ma."entityId" = ANY(${messageIds}::int[])
    ORDER BY ma."entityId", ma.id
  `;
  return Object.fromEntries(rows.map((r) => [r.messageId, r.username ?? 'unknown']));
}
