import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mainAppAutoLabelPoll } from '$lib/server/main-app-autolabel';
import { textCheckCookie } from '$lib/server/text-check';

// Poll one auto-label workflow; the main app only answers the caller's own.
export const GET: RequestHandler = async ({ locals, params, request }) =>
  json(await mainAppAutoLabelPoll(textCheckCookie(locals, request), locals.user.id, params.id));
