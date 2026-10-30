import { withAxiom } from '@civitai/next-axiom';
import { runnerAppFeedbackRoute } from '~/server/services/app-assistant/runner-app-feedback';

/**
 * POST /api/internal/app-assistant/app-feedback/review
 *
 * App Assistant's server runner reads the moderator review of the app open in a chat, FOR the user
 * its run grant names: the listing's status and its listing problems (what My apps lists under
 * "cannot be published yet", and what it recommends), and its latest submissions with their status,
 * dates, the moderator's rejection reason or approval notes and the deploy state — the author's own
 * view on My apps and the listing's History tab, through the same services (`listMyAppListings`,
 * `listListingHistory`). Nothing a moderator alone sees.
 *
 * Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`. Body:
 *   { grant, app }   `app` is the open app's key, its listing slug
 *
 * Re-judged on every call, for the grant's user: the gates the runner's token mint checks and the
 * App Blocks author capability (`getRunnerDevTunnelUser`). The app is found ONLY among the listings
 * the user owns or holds an accepted seat on.
 *
 *   200 `ReviewFeedback` (`@civitai/app-assistant`)
 *   400 `{ error }` the body is not that shape
 *   401 `{ error }` the runner's secret is missing or wrong; `invalid_grant` not a current run grant
 *   403 `refused` an App Assistant gate refuses the user; `FORBIDDEN` no author capability
 *   404 `NOT_FOUND` no listing of the user's under that key: never submitted, or someone else's
 *       (one answer for both)
 *   503 not configured; `unavailable` could not be read just now: retry
 */
export default withAxiom(runnerAppFeedbackRoute('review'));
