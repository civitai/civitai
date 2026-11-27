import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { dismissRecap } from '$lib/server/daily/daily.service';
import { queueDeps } from '$lib/server/queue/runtime';
import type { RequestHandler } from './$types';

/** Marks today's recap seen once the home card shows it. The stored popup opt-out is left as it was. */
export const POST: RequestHandler = async ({ locals }) => {
  try {
    await dismissRecap(db, { playerId: locals.user.id, now: queueDeps.now() });
  } catch (error) {
    console.error('knights: could not store the recap dismissal', { error });
    return json({ message: 'Could not save that. Try again.' }, { status: 500 });
  }
  return json({ ok: true });
};
