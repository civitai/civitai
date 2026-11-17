import { Prisma } from '@prisma/client';
import { uniq } from 'lodash-es';
import type { ChatDmPolicy } from '~/server/schema/chat.schema';
import { inboxStatuses } from '~/shared/utils/chat';

export type DmRouting = 'accept' | 'filter' | 'refuse';

/**
 * Where a single recipient's DM settings put this sender.
 *
 * Only `nobody` refuses. A `following`/`mutuals` policy is a triage rule, not a
 * wall — refusing there would reproduce the all-or-nothing control this
 * replaces, and the recipient can still find the request in Requests and reply.
 */
export function decideDmRouting({
  policy,
  holdNewAccounts,
  senderIsNew,
  recipientFollowsSender,
  senderFollowsRecipient,
}: {
  policy: ChatDmPolicy;
  holdNewAccounts: boolean;
  senderIsNew: boolean;
  recipientFollowsSender: boolean;
  senderFollowsRecipient: boolean;
}): DmRouting {
  if (policy === 'nobody') return 'refuse';
  if (holdNewAccounts && senderIsNew) return 'filter';

  switch (policy) {
    case 'following':
      return recipientFollowsSender ? 'accept' : 'filter';
    case 'mutuals':
      return recipientFollowsSender && senderFollowsRecipient ? 'accept' : 'filter';
    default:
      return 'accept';
  }
}

export const getChatHash = (userIds: number[]) => {
  return uniq(userIds)
    .sort((a, b) => a - b)
    .join('-');
};

export const getUsersFromHash = (hash: string) => {
  return hash.split('-').map((id) => parseInt(id, 10));
};

const inboxStatusLiterals = inboxStatuses.map((status) => `'${status}'`).join(', ');

/**
 * Unread messages per conversation, for the header chat badge.
 *
 * Pending Requests count alongside the inbox: a request nobody is told about is
 * one nobody answers. In a Request a message still does not count when its author
 * and the reader have a block between them, when its author is banned, or when the
 * reader reported the conversation. A block placed after the request leaves its
 * earlier messages unread, and the badge must not call the reader back to them.
 * System rows (user -1) do not count in a Request: a link preview or an "added you"
 * note is written on the sender's behalf, and no block or ban check can see it.
 *
 * Two queries, not one: every signed-in client polls this, and folding the
 * request rules into the inbox query (even as a UNION) slows every poll.
 */
export const unreadCountSql = (userId: number) => [
  inboxUnreadSql(userId),
  requestUnreadSql(userId),
];

const inboxUnreadSql = (userId: number) => Prisma.sql`
  select memb."chatId"          as "chatId",
         count(msg.id)::integer as "cnt"
  from "ChatMember" memb
         left join "ChatMessage" msg
                   on msg."chatId" = memb."chatId" and
                      (msg.id > memb."lastViewedMessageId" or
                       memb."lastViewedMessageId" is null
                        ) and
                      (memb."clearedAt" is null or msg."createdAt" > memb."clearedAt") and
                      msg."deletedAt" is null
  where memb."userId" = ${userId}
    and memb.status in (${Prisma.raw(inboxStatusLiterals)})
    and memb."notifyLevel" <> 'None'
    and memb."filteredAt" is null
    and msg."userId" != ${userId}
  group by memb."chatId"
`;

/** The badge shows a bounded number, so a Request stops counting here. */
const REQUEST_UNREAD_CAP = 99;

const requestUnreadSql = (userId: number) => Prisma.sql`
  select memb."chatId" as "chatId",
         unread.cnt    as "cnt"
  from "ChatMember" memb
         cross join lateral (
    -- authors, not messages, get the block and ban checks: per message they were most of the cost
    select least(coalesce(sum(byAuthor.cnt), 0), ${REQUEST_UNREAD_CAP})::integer as cnt
    from (
      select msg."userId" as "authorId", count(*) as cnt
      from "ChatMessage" msg
      where msg."chatId" = memb."chatId"
        and msg.id > coalesce(memb."lastViewedMessageId", 0)
        and (memb."clearedAt" is null or msg."createdAt" > memb."clearedAt")
        and msg."deletedAt" is null
        and msg."userId" not in (${userId}, -1)
      group by msg."userId"
    ) byAuthor
    -- same two-way rule as the BlockedUsers / BlockedByUsers caches in user-preferences.service
    where not exists (
        select 1 from "UserEngagement" ue
        where ue.type = 'Block'
          and ((ue."userId" = ${userId} and ue."targetUserId" = byAuthor."authorId")
            or (ue."userId" = byAuthor."authorId" and ue."targetUserId" = ${userId}))
      )
      and not exists (
        select 1 from "User" author
        where author.id = byAuthor."authorId" and author."bannedAt" is not null
      )
    ) unread
  where memb."userId" = ${userId}
    and memb.status in (${Prisma.raw(inboxStatusLiterals)})
    and memb."notifyLevel" <> 'None'
    and memb."filteredAt" is not null
    and not exists (
      select 1 from "ChatReport" cr
               join "Report" r on r.id = cr."reportId"
      where cr."chatId" = memb."chatId"
        and (r."userId" = ${userId} or ${userId} = any(r."alsoReportedBy"))
    )
    and unread.cnt > 0
`;

/**
 * "Mark all as read" covers every membership the badge counts, Requests
 * included, so the badge can always be cleared in one action.
 */
export const markAllReadSql = (userId: number) => Prisma.sql`
  update "ChatMember"
  set "lastViewedMessageId" = data.last_msg
  from (select *
        from (select cm.id, cm."lastViewedMessageId" as last_viewed, max(msg.id) as last_msg
              from "ChatMember" cm
                     join "ChatMessage" msg on cm."chatId" = msg."chatId"
              where cm."userId" = ${userId}
                and cm.status in (${Prisma.raw(inboxStatusLiterals)})
              group by 1, 2) d
        where d.last_viewed is distinct from d.last_msg) as data
  where "ChatMember".id = data.id
  returning "chatId", "lastViewedMessageId"
`;
