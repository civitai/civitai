import type { IncomingHttpHeaders } from 'node:http';

import { RUN_FEATURE_EDIT, type StartRunRequest } from '@civitai/components-chat/runner-protocol';

/**
 * What the runner lists in `features` on a start's and a lookup's answer (run protocol v1, typed by
 * `@civitai/components-chat` since 0.31.0): a page uses one only once a runner listed it, so a page
 * that knows none works as before. `edit`: a start with `turn.edit` replaces the saved message of
 * turn `seq`, drops its reply and replies afresh.
 */
export const RUNNER_FEATURES: readonly string[] = [RUN_FEATURE_EDIT];

/** `POST /runs`'s body: v1's, `turn.edit` (the user edited their latest message) included. */
export type StartRequest = StartRunRequest;

/** The request header a start (and a patch) carries its run grant in. */
export const GRANT_HEADER = 'x-run-grant';

/** The run grant a request carries, if any (the first, when a client sent it twice). */
export function grantHeader(headers: IncomingHttpHeaders): string | undefined {
  const value = headers[GRANT_HEADER];
  const grant = Array.isArray(value) ? value[0] : value;
  return grant ? grant.trim() : undefined;
}
