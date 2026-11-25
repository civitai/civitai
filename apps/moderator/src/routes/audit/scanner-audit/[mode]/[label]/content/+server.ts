import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { focusedItemContent } from '$lib/server/scanner-review.service';

// Per-item content resolver for the focused-review cursor (snapshot → orchestrator → image lookup).
export const GET: RequestHandler = async ({ url, locals }) => {
  const content = await focusedItemContent(
    {
      contentHash: url.searchParams.get('contentHash') ?? '',
      workflowId: url.searchParams.get('workflowId') ?? '',
      scanner: url.searchParams.get('scanner') ?? '',
      entityIds: url.searchParams.getAll('entityId'),
    },
    locals.user
  );
  return json(content);
};
