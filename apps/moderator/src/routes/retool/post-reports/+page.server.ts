import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { postReportUrl } from '$lib/entity-url';

// The post report queue moved to `/reports/post` (2026-10-15), beside the other report queues. Kept so
// bookmarks and links already handed round still land on the post they named. `?post=` is the path
// there now (`/reports/post/<id>`); every other param (`page`, the queue filters) means the same and is
// carried as it is.
export const load: PageServerLoad = ({ url }) => {
  const params = new URLSearchParams(url.search);
  const post = Number(params.get('post'));
  params.delete('post');
  const path = Number.isInteger(post) && post > 0 ? postReportUrl(post) : '/reports/post';
  redirect(308, params.size ? `${path}?${params}` : path);
};
