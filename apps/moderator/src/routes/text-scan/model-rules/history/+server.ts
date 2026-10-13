import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { listModelRuleVersions } from '$lib/server/model-rules.service';
import { MAX_INT4 } from '$lib/server/users.service';

const ruleId = z.coerce.number().int().positive().max(MAX_INT4);

export const GET: RequestHandler = async ({ url }) => {
  const parsed = ruleId.safeParse(url.searchParams.get('rule'));
  if (!parsed.success) error(400, 'Invalid rule.');
  return json(await listModelRuleVersions(parsed.data));
};
