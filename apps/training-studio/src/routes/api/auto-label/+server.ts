import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Auto-label is free to the user, and this server only holds the user's orchestrator token: a
// workflow submitted with it is charged to the user. Until there is a system-paid path here, refuse
// rather than charge. (The embedded element gets auto-label from its host instead.)
export const POST: RequestHandler = async () => {
  error(503, 'Auto-labeling is unavailable right now.');
};
