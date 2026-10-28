import { db } from '$lib/server/db';
import { imageUrl } from '$lib/server/image-url';
import { listJudgments } from '$lib/server/progression/judgments';
import { getPlayerStatus, statusFrom } from '$lib/server/player-status';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
  const requested = Number(url.searchParams.get('page'));
  const page = Number.isInteger(requested) && requested >= 1 ? requested : 1;

  const [status, { judgments, hasMore }] = await Promise.all([
    getPlayerStatus(db, locals.user.id),
    listJudgments(db, locals.user.id, { page }),
  ]);

  return {
    page,
    hasMore,
    status: status ?? statusFrom('Acolyte', 0),
    judgments: judgments.map((j) => ({
      ...j,
      src: j.imageKey ? imageUrl(j.imageKey) : null,
      at: j.at.toISOString(),
    })),
  };
};
