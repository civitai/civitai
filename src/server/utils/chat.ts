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
 * Two queries, not one: every signed-in client polls this. Folding the request
 * rules into the inbox query, even as a UNION, grew the plan that big accounts
 * already JIT-compile and cost them 20-200% in latency. The request query alone
 * stays under `jit_above_cost`.
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

const requestUnreadSql = (userId: number) => Prisma.sql`
  select memb."chatId" as "chatId",
         unread.cnt    as "cnt"
  from "ChatMember" memb
         cross join lateral (
    select count(*)::integer as cnt
    from "ChatMessage" msg
    where msg."chatId" = memb."chatId"
      and msg.id > coalesce(memb."lastViewedMessageId", 0)
      and (memb."clearedAt" is null or msg."createdAt" > memb."clearedAt")
      and msg."deletedAt" is null
      and msg."userId" not in (${userId}, -1)
      and not exists (
        select 1 from "UserEngagement" ue
        where ue.type = 'Block'
          and ((ue."userId" = ${userId} and ue."targetUserId" = msg."userId")
            or (ue."userId" = msg."userId" and ue."targetUserId" = ${userId}))
      )
      and not exists (
        select 1 from "User" author where author.id = msg."userId" and author."bannedAt" is not null
      )
      and not exists (
        select 1 from "ChatReport" cr
                 join "Report" r on r.id = cr."reportId"
        where cr."chatId" = memb."chatId" and r."userId" = ${userId}
      )
    ) unread
  where memb."userId" = ${userId}
    and memb.status in (${Prisma.raw(inboxStatusLiterals)})
    and memb."notifyLevel" <> 'None'
    and memb."filteredAt" is not null
    and unread.cnt > 0
`;
