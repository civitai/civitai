import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { assertDevOnly } from '$lib/server/dev/guard';
import { listSimulatableItems, simulateOtherVoters } from '$lib/server/dev/simulate';
import { imageUrl } from '$lib/server/image-url';
import { queueDeps } from '$lib/server/queue/runtime';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  assertDevOnly();
  const items = await listSimulatableItems(db, locals.user.id);
  return { items: items.map((item) => ({ ...item, src: imageUrl(item.imageKey) })) };
};

export const actions: Actions = {
  simulate: async ({ request, locals }) => {
    assertDevOnly();
    const form = await request.formData();
    const itemId = Number(form.get('itemId'));
    const answer = form.get('answer');
    if (!Number.isInteger(itemId) || typeof answer !== 'string') {
      return fail(400, { message: 'Pick an item and an answer.' });
    }

    try {
      const result = await simulateOtherVoters(
        db,
        { callerId: locals.user.id, itemId, answer },
        queueDeps
      );
      return { success: true, ...result };
    } catch (error) {
      console.error('knights: simulating voters failed', { itemId, error });
      return fail(500, { message: 'The simulation failed. Check the server log.' });
    }
  },
};
