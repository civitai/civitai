import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { MAX_INT4 } from '$lib/server/users.service';
import { accountActions, loadAccount } from '../../account.server';

// One account in the queue, in the path so a moderator can hand a colleague the exact view. Details is
// the bare `/reports/user/<id>`; the other tabs are a segment, which `params/suspectTab.ts` limits to
// `SUSPECT_TABS`.
const userIdParam = z.coerce.number().int().positive().max(MAX_INT4);

export const load: PageServerLoad = async ({ params, url, locals }) => {
  const user = userIdParam.safeParse(params.userId);
  if (!user.success) error(404, 'Not a user id');
  return { account: await loadAccount(user.data, params.tab ?? 'details', url, locals) };
};

export const actions = accountActions;
