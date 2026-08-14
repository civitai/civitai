import type { ChatNotifyLevel } from '~/shared/utils/prisma/enums';

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
