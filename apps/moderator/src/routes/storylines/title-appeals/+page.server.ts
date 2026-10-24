import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad, RequestEvent } from './$types';
import {
  getStorylineTitleAppeals,
  resolveStorylineTitleAppeal,
} from '$lib/server/storyline-title-appeal.service';

const LIMIT = 100;

export const load: PageServerLoad = async () => {
  const { items, hasMore } = await getStorylineTitleAppeals({ limit: LIMIT });
  return { items, hasMore, limit: LIMIT };
};

const run = async (event: RequestEvent, grant: boolean) => {
  const form = await event.request.formData();
  const storylineId = Number(form.get('storylineId'));
  const reviewedTitle = form.get('reviewedTitle');
  if (!(storylineId > 0) || typeof reviewedTitle !== 'string')
    return fail(400, { error: 'Missing storyline.' });

  const result = await resolveStorylineTitleAppeal(storylineId, grant, reviewedTitle);
  if (!result.ok) return fail(400, { error: result.error, storylineId });
  return { success: true, storylineId };
};

export const actions: Actions = {
  grant: (event) => run(event, true),
  deny: (event) => run(event, false),
};
