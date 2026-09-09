import { createModeratorClient } from '@civitai/moderation';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

// The main app's single client for delegating moderator mutations to the moderator spoke (apps/moderator),
// which owns that logic. Built on the shared @civitai/moderation client (typed against the same action
// schemas the spoke's `/api/mod/*` endpoint validates) — the mirror of the spoke's syncSearchIndex call
// in the other direction. Import this instance; there should be exactly one configured client. Failures
// are logged and rethrown (mutations aren't retried).
//
// 🔴 THE `||` FALLBACK NO LONGER PROTECTS DEPLOY ORDER — IT IS NOW A SILENT FAILURE PATH.
// It used to: this app and the moderator app deploy from different pipelines, the ConfigMap supplying
// MOD_INBOUND_TOKEN lands from a third (the infra repo), and while the spoke still accepted
// WEBHOOK_TOKEN the legacy arm kept the call working whichever landed first.
//
// 🔴 THE SPOKE HAS NOW DROPPED WEBHOOK_TOKEN FROM ITS ACCEPTED SET, so that arm is a guaranteed 401.
// `||` falls through on an EMPTY local value, never on a REJECTION — so in any environment where
// MOD_INBOUND_TOKEN is unset this silently selects a credential the spoke refuses. Nothing here
// errors: `onFailure` logs to Axiom, the 401 reaches `image.controller.ts` and, being < 500, is
// mapped to a BAD_REQUEST — a moderator clicking block/unblock gets a toast, not an incident.
//
// So MOD_INBOUND_TOKEN is now effectively REQUIRED wherever this client is used, even though the
// schema still types it optional. The fallback is retained only so this caller did not change shape
// in the same commit as the spoke's removal; it is not a working default. Deleting it, and making
// the variable required so a missing key is a loud boot failure rather than a silent 401, is the
// correct follow-up — not a "cleanup" to avoid.
//
// MOD_INBOUND_TOKEN is the narrow, inbound-only credential the moderator app accepts.
// WEBHOOK_TOKEN is the platform-wide admin credential — it authenticates ~134 endpoints in this app,
// so presenting it here was far more authority than this one call needs, which is why the spoke
// stopped accepting it.
//
// 🔴 THE ENDPOINT IS DELIBERATELY *NOT* `MODERATOR_APP_URL`, AND THE TWO ARE NOT INTERCHANGEABLE.
// `MODERATOR_APP_URL` has a second consumer with the opposite requirement: `src/pages/moderator/
// [...slug].tsx` builds a `getServerSideProps` REDIRECT DESTINATION from it, which is a Location
// header sent to a moderator's BROWSER — so that value has to stay publicly resolvable. This call is
// server-to-server and wants the shortest private path instead. Pointing the single shared variable
// at a private address would silently break every migrated /moderator/* link while this call got
// faster, so the two consumers get two variables. `MODERATOR_APP_INTERNAL_URL` is optional and falls
// back to the public one, so an environment that sets neither behaves exactly as it does today.
export const moderatorApp = createModeratorClient({
  endpoint: env.MODERATOR_APP_INTERNAL_URL || env.MODERATOR_APP_URL,
  token: env.MOD_INBOUND_TOKEN || env.WEBHOOK_TOKEN,
  onFailure: (failure) =>
    logToAxiom(
      { type: 'error', name: 'moderator-app-request-failed', ...failure },
      'moderator-app'
    ).catch(() => undefined),
});
