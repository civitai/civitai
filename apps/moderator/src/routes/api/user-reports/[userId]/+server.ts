import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import {
  getReportsOnUser,
  getReportsReceived,
  getReportsSubmitted,
} from '$lib/server/user-reports.service';

// Client-fetched: eighteen joins across six entity types, and only the Reports section shows them.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  const [received, submitted, onUser] = await Promise.all([
    getReportsReceived(userId),
    getReportsSubmitted(userId),
    getReportsOnUser(userId),
  ]);

  return json({ received, submitted, onUser });
};
