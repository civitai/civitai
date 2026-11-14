/** A workflow as read back from the orchestrator, after `withoutCallbacks`. */
export type Callbackless<W> = Omit<W, 'callbacks'>;

/**
 * An orchestrator workflow as the Studio hands it on: without its `callbacks`, which are the
 * submitter's own delivery configuration. Nothing reads them back from a fetched workflow.
 */
export function withoutCallbacks<W extends object>(workflow: W): Callbackless<W> {
  if (!('callbacks' in workflow)) return workflow;
  const { callbacks: _callbacks, ...rest } = workflow as W & { callbacks?: unknown };
  return rest;
}
