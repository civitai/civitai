import type { ChatNotifyLevel } from '~/shared/utils/prisma/enums';

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
