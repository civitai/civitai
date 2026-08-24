import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { parseQuery } from '$lib/server/query';
import { MAX_INT4 } from '$lib/server/users.service';
import {
  NEW_USER_WINDOWS,
  getNewestUsers,
  type NewUserWindow,
} from '$lib/server/new-users.service';
import {
  COMMENT_SPAM_WINDOWS,
  getCommentSpamAccounts,
  type CommentSpamWindow,
} from '$lib/server/comment-spam.service';

const PAGE_SIZES = [50, 100, 200] as const;

const querySchema = z.object({
  days: z.coerce
    .number()
    .refine((n): n is NewUserWindow => (NEW_USER_WINDOWS as readonly number[]).includes(n))
    .catch(7),
  limit: z.coerce
    .number()
    .refine((n) => (PAGE_SIZES as readonly number[]).includes(n))
    .catch(50),
  // `.max(MAX_INT4)`: `User.id` is a Postgres integer, and a larger value ERRORS the comparison
  // rather than missing — a pasted or hand-edited cursor would 500 the page.
  cursor: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  username: z.string().trim().catch(''),
  email: z.string().trim().catch(''),
  // Two views of one question — which fresh accounts are a problem. Registration order is what you
  // read when you do not yet know who they are; the signature list is what you read once they have
  // started posting. Same page, same grant, one query each.
  view: z.enum(['newest', 'spam']).catch('newest'),
  spamDays: z.coerce
    .number()
    .refine((n): n is CommentSpamWindow => (COMMENT_SPAM_WINDOWS as readonly number[]).includes(n))
    .catch(7),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const { days, limit, cursor, username, email, view, spamDays } = parseQuery(url, querySchema);

  // Only the view being rendered runs. The spam query reads ClickHouse and the newest list reads
  // Postgres, so running both would put an outage in one behind every load of the other.
  const [users, spam] = await Promise.all([
    view === 'newest'
      ? getNewestUsers({ days, limit, cursor, username, email })
      : Promise.resolve([]),
    view === 'spam' ? getCommentSpamAccounts({ days: spamDays }) : Promise.resolve([]),
  ]);

  return {
    view,
    spam,
    spamDays,
    spamWindows: COMMENT_SPAM_WINDOWS,
    days,
    limit,
    username,
    email,
    users,
    pageSizes: PAGE_SIZES,
    windows: NEW_USER_WINDOWS,
    // Keyset, not offset: registrations arriving while a moderator reads would shift every later page.
    nextCursor: users.length === limit ? users[users.length - 1].id : null,
  };
};
