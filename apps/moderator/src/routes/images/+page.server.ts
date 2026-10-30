import type { PageServerLoad } from './$types';
import { childLinks } from '$lib/server/access';

// The /images hub lists its sub-pages (role-pruned) as links — no queue of its own.
export const load: PageServerLoad = ({ locals }) => {
  const links = childLinks('/images', locals.user).map((l) => ({
    path: l.path ?? '#',
    label: l.label,
    countKey: l.countKey,
  }));
  return { links };
};
