import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { holdsCsamReview } from '$lib/server/held-media';
import { getWorkflowRaw } from '$lib/server/scanner-content.service';
import { RETRACTED_REFUSED } from '$lib/held-media';

// Raw workflow JSON for the "view raw workflow" drawer. It answers for any workflow id and carries
// the scan's inputs, which can be a withheld image, so only a moderator cleared for those reads it.
export const GET: RequestHandler = async ({ url, locals }) => {
  if (!holdsCsamReview(locals.user)) error(403, RETRACTED_REFUSED);
  return json(await getWorkflowRaw(url.searchParams.get('workflowId') ?? ''));
};
