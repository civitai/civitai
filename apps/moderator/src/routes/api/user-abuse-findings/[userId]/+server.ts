import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getAbuseFindingsForUser } from '$lib/server/abuse-detection.service';

// Everything the automated detectors have said about ONE account, for the Moderation Activity
// section of User Lookup.
//
// 🔴 WHY THIS EXISTS. `/abuse` already links each finding's user id here, and until now the
// destination said nothing about abuse detection at all — a moderator followed the link from the
// evidence to a page with ~20 panels, none of which mentioned why the account had been flagged.
// The round trip was broken at the far end, not at the link.
//
// Fetched client-side like the mod-activity and security-signal panels: one indexed query
// (`abuse_detection_finding_user_idx` on `(user_id, created_at DESC)`), cheap on its own but not
// worth adding to the identity render path, which every section pays for.
//
// 🔴 NOT filtered on `actioned`, deliberately — the service function says so and it is the whole
// point of the panel. "We looked at this account twice and did nothing" is a real answer to "why
// is this creator complaining", and it is the most common one. Filtering to actioned findings
// would turn a record of restraint into a record of enforcement.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  const findings = await getAbuseFindingsForUser(userId);
  return json({ findings });
};
