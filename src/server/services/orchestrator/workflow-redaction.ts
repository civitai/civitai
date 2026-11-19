/**
 * An orchestrator workflow as the site hands it on: without its `callbacks`, which are the site's
 * own delivery configuration. Nothing reads them back from a fetched workflow.
 */
export function withoutCallbacks<W>(workflow: W): W {
  if (!workflow || typeof workflow !== 'object' || !('callbacks' in workflow)) return workflow;
  const { callbacks: _callbacks, ...rest } = workflow as W & { callbacks?: unknown };
  return rest as W;
}
