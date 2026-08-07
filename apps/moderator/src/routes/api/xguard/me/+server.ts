import type { RequestHandler } from './$types';
import { requireApiAccess, ok, type EndpointDoc } from '$lib/server/api-guard';
import { appRoles } from '@civitai/auth';
import { APP } from '$lib/server/access';

export const _doc: EndpointDoc = {
  summary: 'Who the key resolves to. Call this first — it is the cheapest way to prove auth works.',
  returns: 'id, username and the moderator roles the key inherits.',
};

export const GET: RequestHandler = (event) => {
  const { user, viaApiKey } = requireApiAccess(event, '/xguard');
  return ok({
    id: user.id,
    username: user.username,
    roles: appRoles(user, APP),
    viaApiKey,
    // Stated rather than implied: the endpoint list has no way to write ground truth, and this is the
    // field a caller should assert on if it ever thinks it does.
    canWriteGroundTruth: false,
  });
};
