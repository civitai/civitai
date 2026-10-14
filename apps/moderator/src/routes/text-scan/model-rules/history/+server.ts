import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listModelRuleVersions } from '$lib/server/model-rules.service';
import { int4Id } from '$lib/server/query';

export const GET: RequestHandler = async ({ url }) => {
  const parsed = int4Id.safeParse(url.searchParams.get('rule'));
  if (!parsed.success) error(400, 'Invalid rule.');
  return json(await listModelRuleVersions(parsed.data));
};
