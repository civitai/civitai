import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { focusedItemContent } from '$lib/server/scanner-review.service';

// Per-item content resolver for the focused-review cursor (snapshot → orchestrator → image lookup).
export const GET: RequestHandler = async ({ url }) => {
  const content = await focusedItemContent({
    contentHash: url.searchParams.get('contentHash') ?? '',
    workflowId: url.searchParams.get('workflowId') ?? '',
    scanner: url.searchParams.get('scanner') ?? '',
    entityIds: url.searchParams.getAll('entityId'),
  });
  return json(content);
};
