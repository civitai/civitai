import orchestratorCaller from '~/server/http/orchestrator/orchestrator.caller';

/**
 * AIRs of every resource the orchestrator currently holds resident — every type and size. `source`
 * filters on the orchestrator's side (an unknown source returns `[]`); without it the list includes
 * HuggingFace, OCI images, training blobs and more, at about three times the size.
 *
 * `/v1/manager/...` is absent from the OpenAPI documents `@civitai/client` is generated from, so it
 * goes through the caller rather than the client — which is also what puts a request timeout on it.
 */
export async function getLoadedResourceAirs({
  source,
  minSizeBytes,
}: { source?: string; minSizeBytes?: number } = {}): Promise<string[] | null> {
  const queryParams = {
    ...(source ? { source } : {}),
    ...(minSizeBytes != null ? { minSizeBytes } : {}),
  };
  const response = await orchestratorCaller.get<unknown>('/v1/manager/resources/loaded', {
    queryParams,
  });

  // The orchestrator's signal that it is restarting and cannot give a complete list. Not an error:
  // null means "no answer this time", which callers must not read as "nothing loaded".
  if (response.status === 503) return null;
  if (!response.ok)
    throw new Error(
      `loaded resources: ${response.status} ${'message' in response ? response.message : ''}`.trim()
    );

  const data = 'data' in response ? response.data : null;
  // Not read as "nothing loaded": the caller could not tell an empty fleet from a response shape that
  // moved.
  if (!Array.isArray(data)) throw new Error('loaded resources: expected an array of AIRs');

  return data.filter((x): x is string => typeof x === 'string');
}
