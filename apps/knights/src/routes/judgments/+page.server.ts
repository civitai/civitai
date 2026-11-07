import { db } from '$lib/server/db';
import { imagePageUrl, imageUrl, THUMBNAIL_WIDTH } from '$lib/server/image-url';
import { listJudgments, parseJudgmentFilter } from '$lib/server/progression/judgments';
import { requireMember } from '$lib/server/membership';
import type { PageServerLoad } from './$types';

const MAX_PAGE = 1000;

export const load: PageServerLoad = async ({ locals, url }) => {
  const requested = Number(url.searchParams.get('page'));
  const page =
    Number.isSafeInteger(requested) && requested >= 1 && requested <= MAX_PAGE ? requested : 1;

  const filter = parseJudgmentFilter(url.searchParams.get('status'));

  const [status, { judgments, hasMore }] = await Promise.all([
    requireMember(db, locals.user.id),
    listJudgments(db, locals.user.id, { page, filter }),
  ]);

  return {
    page,
    filter,
    hasMore,
    status,
    judgments: judgments.map((j) => ({
      ...j,
      imageHref: j.imageKey ? imagePageUrl(j.imageId) : null,
      src: j.imageKey ? imageUrl(j.imageKey, THUMBNAIL_WIDTH) : null,
      at: j.at.toISOString(),
    })),
  };
};
