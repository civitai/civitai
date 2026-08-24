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
});

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const { days, limit, cursor, username, email } = parseQuery(url, querySchema);

  const users = await getNewestUsers({ days, limit, cursor, username, email });

  return {
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
