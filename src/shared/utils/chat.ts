import { ChatMemberStatus, ChatNotifyLevel } from '~/shared/utils/prisma/enums';

export type ChatBucket = 'Inbox' | 'Requests' | 'Archived';

const archivedStatuses: ChatMemberStatus[] = [
  ChatMemberStatus.Ignored,
  ChatMemberStatus.Left,
  ChatMemberStatus.Kicked,
];

/**
 * `filteredAt` marks a membership as a pending request, whatever its status — a
 * conversation you once accepted becomes a request again if you delete it and
 * the other side writes back. Accepting clears the mark, so an accepted chat
 * cannot be stranded in Requests.
 */
export function chatBucketFor(member: {
  status: ChatMemberStatus;
  filteredAt: Date | null;
}): ChatBucket {
  if (archivedStatuses.includes(member.status)) return 'Archived';
  if (member.filteredAt) return 'Requests';
  return 'Inbox';
}

/**
 * Shared by the `createMessageInput` cap and the composer's counter. Lives here
 * rather than in `server/common/constants` because `chat.schema.ts` is a leaf the
 * client `_app` bundle imports — pulling the server constants module in from
 * there throws `constants is not defined` at request time, which typecheck does
 * not see.
 */
export const MAX_CHAT_MESSAGE_LENGTH = 2000;

/**
 * Whether an incoming message should ring for a member, given their
 * per-conversation notification level.
 *
 * `Mentions` matches a literal `@username`. Chat has no mention parser — the
 * composer writes plain text — so a boundary-checked substring match is the
 * whole of it, and a level that cannot be satisfied must not fall back to
 * notifying or the setting would read as broken.
 */
export function shouldNotifyForMessage({
  level,
  content,
  username,
}: {
  level: ChatNotifyLevel;
  content: string;
  username?: string | null;
}): boolean {
  if (level === 'None') return false;
  if (level === 'Mentions') return !!username && mentionsUser(content, username);
  return true;
}

function mentionsUser(content: string, username: string): boolean {
  const needle = `@${username.toLowerCase()}`;
  const haystack = content.toLowerCase();

  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    // Reject @alicia matching a mention of @aliciaB, but allow trailing
    // punctuation — "@alicia," and "@alicia" are the same address.
    const next = haystack[at + needle.length];
    if (next === undefined || !/[a-z0-9_-]/.test(next)) return true;
    from = at + 1;
  }
}

/**
 * What to write to the two mute columns for one membership change.
 *
 * They are written by different surfaces — the previous chat writes `isMuted`,
 * the redesign writes `notifyLevel` — and every server reader is on
 * `notifyLevel`, so each has to be derived from the other or a mute made on one
 * surface does nothing on the rest.
 *
 * The column the caller actually named wins. Deriving unconditionally sends
 * `undefined` for it, which Prisma reads as "leave alone", so the request
 * updates the mirror and not the field it was about.
 */
export function deriveMuteColumns(input: { isMuted?: boolean; notifyLevel?: ChatNotifyLevel }): {
  isMuted: boolean | undefined;
  notifyLevel: ChatNotifyLevel | undefined;
} {
  const { isMuted, notifyLevel } = input;

  return {
    notifyLevel:
      notifyLevel ??
      (isMuted === undefined ? undefined : isMuted ? ChatNotifyLevel.None : ChatNotifyLevel.All),
    isMuted:
      isMuted ?? (notifyLevel === undefined ? undefined : notifyLevel === ChatNotifyLevel.None),
  };
}
/**
 * Every per-member field that says something about how a person uses a
 * conversation. Naming them in the constraint rather than accepting any member
 * shape is the point: adding one to `chatSelect` without adding it here stops
 * compiling instead of silently shipping it to the other side.
 */
export type PrivateMemberFields = {
  userId: number;
  filteredAt: Date | null;
  clearedAt: Date | null;
  notifyLevel: ChatNotifyLevel;
  pinnedAt: Date | null;
  isMuted: boolean;
  lastViewedMessageId: number | null;
};

export const scopeMemberPrivacy =
  (userId: number) =>
  <T extends PrivateMemberFields>(member: T): T =>
    member.userId === userId
      ? member
      : {
          ...member,
          filteredAt: null,
          clearedAt: null,
          notifyLevel: ChatNotifyLevel.All,
          pinnedAt: null,
          // Mirrors `notifyLevel`, so scrubbing only that one still answered
          // "have they muted me?".
          isMuted: false,
          // A read receipt nobody renders — every reader of this field takes it
          // off their own membership.
          lastViewedMessageId: null,
        };

/**
 * Rebuild the `Date` fields on a chat message that arrived over a websocket.
 *
 * A signal payload is JSON, so every date on it is a string — but the handler
 * receives it typed as the router's own output, where those fields are `Date`.
 * Nothing in the type system objects, and nothing objects at write time either:
 * the value lands in the react-query cache and the throw happens later, in
 * whichever consumer first calls a `Date` method on it. That was `isSameDay`,
 * two components away, taking the whole page down through the error boundary.
 *
 * So the conversion belongs here, once, on the way in — not at each consumer,
 * and not as a cast at one call site that the next date field would outlive.
 */
export function reviveChatMessageDates<
  T extends {
    createdAt: Date;
    editedAt?: Date | null;
    deletedAt?: Date | null;
    referenceMessage?: { createdAt: Date; deletedAt?: Date | null } | null;
  }
>(message: T): T {
  const toDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));
  const toDateOrNull = <V extends Date | null | undefined>(value: V) =>
    (value == null ? value : toDate(value as Date)) as V;

  return {
    ...message,
    createdAt: toDate(message.createdAt),
    editedAt: toDateOrNull(message.editedAt),
    deletedAt: toDateOrNull(message.deletedAt),
    referenceMessage: message.referenceMessage
      ? {
          ...message.referenceMessage,
          createdAt: toDate(message.referenceMessage.createdAt),
          deletedAt: toDateOrNull(message.referenceMessage.deletedAt),
        }
      : message.referenceMessage,
  };
}
