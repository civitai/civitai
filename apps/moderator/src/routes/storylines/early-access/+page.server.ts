import type { PageServerLoad } from './$types';
import { getStorylineEarlyAccessSignups } from '$lib/server/storyline-early-access.service';

const LIMIT = 100;

export const load: PageServerLoad = async ({ url }) => {
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page'))) || 1);
  const { items, total } = await getStorylineEarlyAccessSignups({
    limit: LIMIT,
    offset: (page - 1) * LIMIT,
  });
  return { items, total, page, limit: LIMIT };
};
