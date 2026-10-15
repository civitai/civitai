import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { MAX_INT4 } from '$lib/server/users.service';
import { postQueueActions } from '../../actions.server';
import { loadPostItem } from '../../item.server';

// The queue opened on one post and tab, in the path so a link opens the same view for whoever follows
// it. Images is the bare `/reports/post/<id>`; the other tabs are a segment, which
// `params/postTab.ts` limits to `POST_TABS`.
export const load: PageServerLoad = async ({ params, locals }) => {
  const postId = Number(params.postId);
  if (!Number.isInteger(postId) || postId <= 0 || postId > MAX_INT4) error(404, 'Not a post id');
  return { item: await loadPostItem(postId, params.tab ?? 'images', locals) };
};

export const actions = postQueueActions;
