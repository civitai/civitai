import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getUserMessagesById } from '$lib/server/chat-audit.service';

// READS PRIVATE DIRECT MESSAGES, so it is gated on CHAT AUDIT's page grant rather than User Lookup's.
// User Lookup is granted far more widely; serving message bodies under its own grant would hand every
// holder of it the DM corpus by a side door.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/chat-audit');
  return json(await getUserMessagesById(userId));
};
