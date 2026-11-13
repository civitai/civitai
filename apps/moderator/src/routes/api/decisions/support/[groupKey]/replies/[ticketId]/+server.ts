import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/api-guard';
import { requireAccess } from '$lib/server/access';
import {
  getSupportGroup,
  groupMember,
  isGroupKey,
  isRouterVersion,
  isTicketId,
} from '$lib/server/decision-sources/support';
import { getPublicAgentReplies } from '$lib/server/freshdesk.service';

/**
 * A group member's public agent replies — what the group page offers to pre-fill a `resolved` answer
 * from. External HTTP, so it is fetched by the panel on a click rather than held in the page load.
 *
 * 🔴 ONLY FOR A CURRENT MEMBER OF THE GROUP, in the version the page showed. Without that this would
 * read any ticket in the Freshdesk account for anyone who can open `/decisions`.
 *
 * Gated like the write it feeds: `/api/*` skips the central route gate, so the page grant is checked
 * here, and both permissions a `resolved` ruling needs.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
  requireAccess(locals.user, '/decisions');
  requirePermission(locals, 'decisions.rule');
  requirePermission(locals, 'decisions.answer');

  const version = url.searchParams.get('version');
  if (!isGroupKey(params.groupKey) || !isTicketId(params.ticketId) || !isRouterVersion(version))
    error(400, 'Bad group, ticket or version.');

  let isMember: boolean;
  try {
    const detail = await getSupportGroup({ version, groupKey: params.groupKey });
    isMember = detail !== null && groupMember(detail, params.ticketId) !== null;
  } catch (e) {
    console.error('[decisions] router read failed', e);
    return json({ error: "Could not read the router's data." }, { status: 503 });
  }
  if (!isMember) error(404, 'That ticket is not in this group any more — reload the page.');

  return json(await getPublicAgentReplies(params.ticketId));
};
