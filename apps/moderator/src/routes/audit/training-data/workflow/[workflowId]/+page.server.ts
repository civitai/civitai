import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad, RequestEvent } from './$types';
import {
  getTrainingWorkflowDetail,
  moderateTrainingWorkflow,
} from '$lib/server/training-moderation.service';

// Access is the parent page's: `canAccess` resolves this path to the `/audit/training-data` grant by
// longest prefix, for the page load and its form actions alike, so it needs no NAVIGATION entry.

export const load: PageServerLoad = async ({ params }) => {
  const loaded = await getTrainingWorkflowDetail(params.workflowId);
  if (!loaded.ok) error(loaded.status, loaded.error);
  return { detail: loaded.detail };
};

const rule = async (event: RequestEvent, approve: boolean) => {
  const form = await event.request.formData();
  const reason = form.get('reason');
  const result = await moderateTrainingWorkflow({
    // The id is the route's, never a form field: the action rules on the run this page is about.
    workflowId: event.params.workflowId,
    approve,
    message: typeof reason === 'string' ? reason : null,
    moderatorId: event.locals.user.id,
  });
  if (!result.ok) return fail(400, { error: result.error });
  return { success: true, moderationStatus: result.moderationStatus };
};

export const actions: Actions = {
  approve: (event) => rule(event, true),
  deny: (event) => rule(event, false),
};
