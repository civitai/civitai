import { error } from '@sveltejs/kit';
import { AUTO_LABEL_UNAVAILABLE_CODE } from '$lib/autolabel-errors';
import type { RequestHandler } from './$types';

// Auto-label is free to the user, and this server only holds the user's orchestrator token: a
// workflow submitted with it is charged to the user. Until there is a system-paid path here, refuse
// rather than charge. (The embedded element gets auto-label from its host instead.) The code lets
// the client tell this refusal from an upstream 503, so it can return the image's cap slot.
export const POST: RequestHandler = async () => {
  error(503, {
    message: 'Auto-labeling is unavailable right now.',
    code: AUTO_LABEL_UNAVAILABLE_CODE,
  });
};
