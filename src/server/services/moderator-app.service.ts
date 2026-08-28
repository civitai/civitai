import { createModeratorClient } from '@civitai/moderation';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

// The main app's single client for delegating moderator mutations to the moderator spoke (apps/moderator),
// which owns that logic. Built on the shared @civitai/moderation client (typed against the same action
// schemas the spoke's `/api/mod/*` endpoint validates) — the mirror of the spoke's syncSearchIndex call
// in the other direction. Import this instance; there should be exactly one configured client. Failures
// are logged and rethrown (mutations aren't retried).
//
// 🔴 THE `||` FALLBACK IS THE DESIGN, NOT A LEFTOVER — do not "clean it up" into a required var.
// This app and the moderator app deploy from different pipelines, and the ConfigMap supplying
// MOD_INBOUND_TOKEN lands from a third one (the infra repo). The fallback makes that ordering
// irrelevant: config first and nothing changes; code first and the call keeps working on the legacy
// token. Remove it and there is a window in which this call is simply broken.
//
// MOD_INBOUND_TOKEN is the narrow, inbound-only credential the moderator app accepts.
// WEBHOOK_TOKEN is the platform-wide admin credential — it authenticates ~134 endpoints in this app,
// so presenting it here is far more authority than this one call needs. The moderator app is dropping
// it from its accepted set; once MOD_INBOUND_TOKEN is set in every environment, the fallback (and
// then this comment) can go.
export const moderatorApp = createModeratorClient({
  endpoint: env.MODERATOR_APP_URL,
  token: env.MOD_INBOUND_TOKEN || env.WEBHOOK_TOKEN,
  onFailure: (failure) =>
    logToAxiom(
      { type: 'error', name: 'moderator-app-request-failed', ...failure },
      'moderator-app'
    ).catch(() => undefined),
});
