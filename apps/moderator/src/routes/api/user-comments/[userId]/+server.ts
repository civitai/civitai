import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { int4Id, parseQuery } from '$lib/server/query';
import { countComments, getComments, isCommentCursorAt } from '$lib/server/user-account.service';

const COMMENTS_PER_PAGE = 50;

const querySchema = z.object({
  before: z.string().refine(isCommentCursorAt).optional().catch(undefined),
  beforeId: int4Id.optional().catch(undefined),
});

export const GET: RequestHandler = async ({ params, locals, url }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  const q = parseQuery(url, querySchema);
  const before = q.before && q.beforeId ? { at: q.before, id: q.beforeId } : undefined;
  const [page, total] = await Promise.all([
    getComments(userId, COMMENTS_PER_PAGE, before),
    countComments(userId),
  ]);
  return json({ ...page, total });
};
