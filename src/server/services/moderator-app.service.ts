import { createModeratorClient } from '@civitai/moderation';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

// The main app's single client for delegating moderator mutations to the moderator spoke (apps/moderator),
// which owns that logic. Built on the shared @civitai/moderation client (typed against the same action
// schemas the spoke's `/api/mod/*` endpoint validates), authenticated with the shared WEBHOOK_TOKEN — the
// mirror of the spoke's syncSearchIndex call in the other direction. Import this instance; there should be
// exactly one configured client. Failures are logged and rethrown (mutations aren't retried).
export const moderatorApp = createModeratorClient({
  endpoint: env.MODERATOR_APP_URL,
  token: env.WEBHOOK_TOKEN,
  onFailure: (failure) =>
    logToAxiom(
      { type: 'error', name: 'moderator-app-request-failed', ...failure },
      'moderator-app'
    ).catch(() => {}),
});
