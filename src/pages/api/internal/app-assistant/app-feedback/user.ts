import { withAxiom } from '@civitai/next-axiom';
import { runnerAppFeedbackRoute } from '~/server/services/app-assistant/runner-app-feedback';

/**
 * POST /api/internal/app-assistant/app-feedback/user
 *
 * App Assistant's server runner reads one page of the private feedback end users sent about the app
 * open in a chat (its owner inbox), FOR the user its run grant names, through the same service as
 * `appFeedback.listForListing` (`listAppFeedbackForListing`: the owner's and an editor's view, minus
 * rows a moderator hid and rows of banned reporters). Read only: no status change, no reply. The
 * reporter's identity is not returned.
 *
 * Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`. Body:
 *   { grant, app, status?, limit?, cursor? }
 *   `status` new (default) | acknowledged | resolved | wont_fix | all; `limit` 1-50 (20);
 *   `cursor` the `nextCursor` of the page before
 *
 * Gates and lookup as `review` (a sibling of this file); the inbox further needs the owner or
 * editor role on the listing.
 *
 *   200 `UserFeedbackPage` (`@civitai/app-assistant`)
 *   400, 401, 403, 503 as `review`
 *   404 `NOT_FOUND` no listing of the user's under that key, or not one whose inbox they may read
 *       (one answer for all)
 */
export default withAxiom(runnerAppFeedbackRoute('user'));
