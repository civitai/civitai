import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { assertDevOnly } from '$lib/server/dev/guard';
import { MAX_LEVEL } from '$lib/server/progression/levels';
import { setPlayerLevel } from '$lib/server/dev/set-level';
import { listSimulatableItems, simulateOtherVoters } from '$lib/server/dev/simulate';
import { imageUrl } from '$lib/server/image-url';
import { getPlayerStatusOrNew } from '$lib/server/player-status';
import { legacyExpForget } from '$lib/server/progression/legacy-exp';
import { queueDeps } from '$lib/server/queue/runtime';
import { getSysRedis } from '$lib/server/redis';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  assertDevOnly();
  const [items, status] = await Promise.all([
    listSimulatableItems(db, locals.user.id),
    getPlayerStatusOrNew(db, locals.user.id),
  ]);
  return { status, items: items.map((item) => ({ ...item, src: imageUrl(item.imageKey) })) };
};

export const actions: Actions = {
  setLevel: async ({ request, locals }) => {
    assertDevOnly();
    const level = Number((await request.formData()).get('level'));
    const result = await setPlayerLevel(db, locals.user.id, level, legacyExpForget(getSysRedis));
    if (!result.ok) {
      return fail(400, {
        message:
          result.reason === 'bad-level'
            ? `Pick a level from 1 to ${MAX_LEVEL}.`
            : 'You have not joined the Order yet.',
      });
    }
    return { success: true, levelSet: level, rank: result.rank };
  },

  simulate: async ({ request, locals }) => {
    assertDevOnly();
    const form = await request.formData();
    const itemId = Number(form.get('itemId'));
    const answer = form.get('answer');
    if (!Number.isInteger(itemId) || typeof answer !== 'string') {
      return fail(400, { message: 'Pick an item and an answer.', itemId });
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
      return fail(500, { message: 'The simulation failed. Check the server log.', itemId });
    }
  },
};
