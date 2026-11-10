import { spokeAuthorize } from '@civitai/auth';
import { getLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request, url }) =>
  spokeAuthorize(request, {
    onEvent: (outcome, detail) =>
      void getLogger().logToAxiom({ name: 'auth-flow', step: 'authorize', outcome, host: url.host, ...detail }).catch(() => {}),
  });
