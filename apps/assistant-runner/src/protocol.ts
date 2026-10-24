import type { StartRunRequest } from '@civitai/components-chat/runner-protocol';

/**
 * What this runner adds to run protocol v1 beyond the `@civitai/components-chat` it is built against
 * (0.25.0 types neither): `turn.edit` on a start, and `features` on a start's and a lookup's answer.
 * Both are optional, so a page that knows neither works as before. Once the runner is bumped to a
 * components-chat that types them, these give way to the package's own.
 */

/**
 * What the runner lists in `features`: a page uses one only once a runner listed it.
 * `edit`: a start with `turn.edit` replaces the saved message of turn `seq`, drops its reply and
 * replies afresh.
 */
export const RUNNER_FEATURES: readonly string[] = ['edit'];

/** `POST /runs`'s body: v1's, and `turn.edit` (the user edited their latest message). */
export type StartRequest = Omit<StartRunRequest, 'turn'> & {
  turn: StartRunRequest['turn'] & { edit?: boolean };
};
