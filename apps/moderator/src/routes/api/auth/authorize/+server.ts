import { spokeAuthorize } from '@civitai/auth';
import { logToAxiom } from '$lib/server/axiom';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request, url }) =>
  spokeAuthorize(request, {
    onEvent: (outcome, detail) =>
      void logToAxiom({
        type: 'info',
        name: 'auth-flow',
        step: 'authorize',
        outcome,
        host: url.host,
        ...detail,
      }).catch(() => {}),
  });
