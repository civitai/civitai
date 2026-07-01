import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getModeratorArticles } from '$lib/server/articles.service';
import { moderateArticle } from '$lib/server/article-moderation';
import { ArticleStatus } from '$lib/articles';

const isFilterStatus = (v: string | null): v is ArticleStatus =>
  v === ArticleStatus.Unpublished || v === ArticleStatus.UnpublishedViolation;

export const load: PageServerLoad = async ({ url }) => {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const username = url.searchParams.get('username')?.trim() || '';
  const statusParam = url.searchParams.get('status');
  // Absent/invalid → the default "all unpublished" view (both statuses).
  const status = isFilterStatus(statusParam) ? statusParam : undefined;

  const data = await getModeratorArticles({ page, username: username || undefined, status });

  return { status: status ?? 'all', username, ...data };
};

// Access is enforced globally (hooks.server.ts), so locals.user is a moderator here.
async function runAction(action: 'restore' | 'delete', request: Request, userId: number) {
  const form = await request.formData();
  const articleId = Number(form.get('id'));
  if (!articleId) return fail(400, { error: 'Missing article id' });

  const result = await moderateArticle({ action, articleId, userId });
  if (!result.ok) return fail(502, { error: result.error });
  return { success: true };
}

export const actions: Actions = {
  restore: ({ request, locals }) => runAction('restore', request, locals.user.id),
  delete: ({ request, locals }) => runAction('delete', request, locals.user.id),
};
