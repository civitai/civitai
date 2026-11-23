import { withAxiom } from '@civitai/next-axiom';
import { runnerTurnRoute } from '~/server/services/app-assistant/runner-turn';

/**
 * POST /api/internal/app-assistant/turn
 *
 * App Assistant's server runner reports each finished turn here, once, in the background (its
 * `CivitaiTurnReports`), FOR the user and the chat its run grant names. civitai records it for
 * session tracing: the chat ↔ app link row and one ClickHouse row (`recordAssistantTurn`). While
 * the `app-assistant-tracing` flag is off it records nothing and still answers 200.
 *
 * Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`. Body:
 *   { v: 1, grant, app, seq, runId, model, status, buzz, toolCalls, durationMs, startedAt, endedAt }
 *   `app` is the chat's chosen app key (its blockId) or null; `toolCalls` counts calls by tool name.
 *
 *   200 `{ tracing, linked, event }` what was recorded (all false while the flag is off)
 *   400 `{ error }` the body is not that shape
 *   401 `{ error }` the runner's secret is missing or wrong; `invalid_grant` not a current run grant
 *   403 `refused` a preview grant, which runs no reply
 *   503 not configured; `unavailable` could not record just now (never retried: it is analytics)
 */
export default withAxiom(runnerTurnRoute);
