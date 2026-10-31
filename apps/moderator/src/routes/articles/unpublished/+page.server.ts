import { imageKeptReasonLabel } from '$lib/image-kept-reasons';
import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { getModeratorArticles } from '$lib/server/articles.service';
import { moderateArticle } from '$lib/server/article-moderation';
import { ArticleStatus } from '$lib/articles';
import { parseQuery } from '$lib/server/query';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  username: z.string().trim().catch(''),
  // Absent / 'all' / invalid → undefined → the default "all unpublished" view (both statuses).
  status: z
    .enum([ArticleStatus.Unpublished, ArticleStatus.UnpublishedViolation])
    .optional()
    .catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  const { page, username, status } = parseQuery(url, querySchema);

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
  // Only the label reaches the browser; the reason would say which hold applies.
  const kept = (result.kept ?? []).map(({ id, reason }) => ({
    id,
    label: imageKeptReasonLabel[reason],
  }));
  return { success: true, kept };
}

export const actions: Actions = {
  restore: ({ request, locals }) => runAction('restore', request, locals.user.id),
  delete: ({ request, locals }) => runAction('delete', request, locals.user.id),
};
