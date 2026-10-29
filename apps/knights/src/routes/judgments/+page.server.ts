import { db } from '$lib/server/db';
import { imageUrl } from '$lib/server/image-url';
import { listJudgments } from '$lib/server/progression/judgments';
import { requireMember } from '$lib/server/membership';
import type { PageServerLoad } from './$types';

const MAX_PAGE = 1000;

export const load: PageServerLoad = async ({ locals, url }) => {
  const requested = Number(url.searchParams.get('page'));
  const page =
    Number.isSafeInteger(requested) && requested >= 1 && requested <= MAX_PAGE ? requested : 1;

  const [status, { judgments, hasMore }] = await Promise.all([
    requireMember(db, locals.user.id),
    listJudgments(db, locals.user.id, { page }),
  ]);

  return {
    page,
    hasMore,
    status,
    judgments: judgments.map((j) => ({
      ...j,
      src: j.imageKey ? imageUrl(j.imageKey) : null,
      at: j.at.toISOString(),
    })),
  };
};
