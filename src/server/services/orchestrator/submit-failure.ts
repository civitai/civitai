/**
 * What a failed `submitWorkflow` knew about the orchestrator RESPONSE it failed on:
 * which attempt of its internal retry loop received it, and the HTTP status.
 *
 * Attached by `submitWorkflow` to the error it throws for a status-bearing
 * orchestrator response, as a non-enumerable symbol property — so the error's code,
 * message, cause, enumerable keys and serialisation are unchanged for every caller.
 * Absent on any other failure (a network failure or timeout after the last retry,
 * or a throw before the call).
 */
export type OrchestratorSubmitFailure = { attempt: number; status: number };

const SUBMIT_FAILURE = Symbol('orchestrator.submitFailure');

export function annotateOrchestratorSubmitFailure(
  err: unknown,
  failure: OrchestratorSubmitFailure
): void {
  if (err === null || typeof err !== 'object' || !Object.isExtensible(err)) return;
  Object.defineProperty(err, SUBMIT_FAILURE, {
    value: failure,
    enumerable: false,
    configurable: true,
  });
}

export function getOrchestratorSubmitFailure(err: unknown): OrchestratorSubmitFailure | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  return (err as { [SUBMIT_FAILURE]?: OrchestratorSubmitFailure })[SUBMIT_FAILURE];
}

const MISSING_BLOB = Symbol('orchestrator.submitMissingBlob');

/**
 * Marks the error `submitWorkflow` throws when refreshing a blob URL in the body got an
 * ANSWER saying the blob itself is gone (a 404, or a blob reported blocked or
 * unavailable) — as opposed to a refresh that failed in transit and may succeed on a
 * retry. Same non-enumerable symbol shape as above, so the error's code, message and
 * serialisation are unchanged for every caller.
 */
export function annotateOrchestratorMissingBlob(err: unknown): void {
  if (err === null || typeof err !== 'object' || !Object.isExtensible(err)) return;
  Object.defineProperty(err, MISSING_BLOB, { value: true, enumerable: false, configurable: true });
}

export function isOrchestratorMissingBlob(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  return (err as { [MISSING_BLOB]?: boolean })[MISSING_BLOB] === true;
}

/**
 * True only when a submit failure proves the orchestrator created no workflow: a 4xx
 * received by the FIRST attempt. A later attempt runs only after an earlier one hit a
 * network failure or 5xx — exactly when that earlier attempt may have created and
 * charged the workflow — so a 4xx there (a dedupe miss can answer with a funds, budget
 * or rate-limit refusal) proves nothing. A 409 is the orchestrator reporting an
 * existing workflow for the same external id, so it is never a refusal. Anything
 * without a recorded response is not a refusal either.
 */
export function isDefiniteOrchestratorSubmitRefusal(err: unknown): boolean {
  const failure = getOrchestratorSubmitFailure(err);
  if (!failure) return false;
  const { attempt, status } = failure;
  return attempt === 1 && status >= 400 && status < 500 && status !== 409;
}
