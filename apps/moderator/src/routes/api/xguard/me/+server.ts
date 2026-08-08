import type { RequestHandler } from './$types';
import { requireXguardToken, ok, type EndpointDoc } from '$lib/server/api-guard';

export const _doc: EndpointDoc = {
  summary: 'Confirms the token is accepted. Call this first — it is the cheapest way to prove auth works.',
  returns: 'What the token may do. There is no user behind it, so there is nobody to report.',
};

export const GET: RequestHandler = ({ request }) => {
  requireXguardToken(request);
  return ok({
    authenticated: true,
    // Stated rather than implied: the endpoint list has no way to write ground truth, and this is the
    // field a caller should assert on if it ever thinks it does.
    canWriteGroundTruth: false,
  });
};
