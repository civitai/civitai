import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { getModeratorDb } from '$lib/server/moderator-db';
import { canOpenWorkspace } from '$lib/server/text-scan-tests/guard';
import { listSets } from '$lib/server/text-scan-tests/store';
import { WORKSPACES, type SetOption } from '$lib/text-scan-tests/types';

export const GET: RequestHandler = async ({ url, locals }) => {
  const workspace = z.enum(WORKSPACES).safeParse(url.searchParams.get('workspace'));
  if (!workspace.success) error(400, 'Unknown workspace.');
  if (!canOpenWorkspace(locals.user, workspace.data)) error(403, 'You cannot open this workspace.');
  const sets = await listSets(getModeratorDb(), workspace.data);
  return json({
    sets: sets.map(({ id, name, caseCount }): SetOption => ({ id, name, caseCount })),
  });
};
