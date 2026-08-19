import { uniq } from 'lodash-es';
import type { ChatDmPolicy } from '~/server/schema/chat.schema';

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
