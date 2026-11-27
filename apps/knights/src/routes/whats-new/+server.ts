import { json } from '@sveltejs/kit';
import { dismissUpdates } from '$lib/server/seen';
import { seenStore } from '$lib/server/seen-runtime';
import type { RequestHandler } from './$types';

/** Records every "What's new" entry so far as seen; the header dialog posts here when it closes. */
export const POST: RequestHandler = async ({ locals }) => {
  if (!(await dismissUpdates(seenStore, locals.user.id))) {
    return json({ message: 'Could not save that. Try again.' }, { status: 500 });
  }
  return json({ ok: true });
};
