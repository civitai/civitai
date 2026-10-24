import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { canAccess, canSeeAddresses } from '$lib/server/access';
import { getDossier } from '$lib/server/dossier.service';
import { maskLinkedAddresses } from '$lib/server/ip-links.service';

/**
 * The report dossier for one account — the user report queue's summary panel. Open to the same two
 * pages as `/api/shared-ip-accounts`. What those pages do not themselves open is withheld rather than
 * served: the addresses go only to a caller who could read them in User Lookup, and detector findings
 * only to one who can open `/abuse` (User Lookup decides its abuse panel the same way).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, ['/retool/user-lookup', '/reports/user']);
  const dossier = await getDossier(userId);
  if (!dossier) return json(null, { status: 404 });
  const showIps = canSeeAddresses(locals);
  const showAbuse = canAccess(locals.user, '/abuse');
  return json({
    ...dossier,
    linked: dossier.linked && !showIps ? maskLinkedAddresses(dossier.linked) : dossier.linked,
    abuse: showAbuse ? dossier.abuse : null,
    // With /abuse, a null `abuse` means the read failed; the panel must not show that as no findings.
    abuseShown: showAbuse,
  });
};
