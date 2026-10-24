import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getWorkflowRaw } from '$lib/server/scanner-content.service';

// Raw workflow JSON for the "view raw workflow" drawer.
export const GET: RequestHandler = async ({ url }) => {
  return json(await getWorkflowRaw(url.searchParams.get('workflowId') ?? ''));
};
