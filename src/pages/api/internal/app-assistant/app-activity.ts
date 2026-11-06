import { withAxiom } from '@civitai/next-axiom';
import { runnerAppActivityRoute } from '~/server/services/app-assistant/runner-app-activity';

/**
 * POST /api/internal/app-assistant/app-activity
 *
 * App Assistant's server runner reads what the app open in a chat did in the last 2 hours, FOR the
 * user its run grant names: its generations, its calls to Civitai and the errors its live preview
 * reported (`AppActivity` from `@civitai/app-assistant`), through the same read the page's preview
 * strip uses (`readAppActivity`).
 *
 * Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`. Body:
 *   { grant, app }   `app` is the open app's key, its blockId
 *
 * Re-judged on every call, for the grant's user: the gates the runner's token mint checks and the
 * App Blocks author capability (`getRunnerDevTunnelUser`). The app is looked up as the user's own
 * dev app, and every part is read as that user only.
 *
 *   200 `AppActivity`
 *   400 `{ error }` the body is not that shape
 *   401 `{ error }` the runner's secret is missing or wrong; `invalid_grant` not a current run grant
 *   403 `refused` an App Assistant gate refuses the user; `FORBIDDEN` no author capability
 *   404 `NOT_FOUND` not an app of the user's (someone else's, or none): one answer for both
 *   503 not configured; `unavailable` could not be read just now: retry
 */
export default withAxiom(runnerAppActivityRoute);
