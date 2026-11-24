/** The host half of the element's `modelLive`: whether the run's model (and, when given, its version)
 *  still counts for the caller (not missing, not deleted by its owner). */
export async function checkStudioModelLive(
  modelId: number,
  modelVersionId?: number,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const versionParam = modelVersionId ? `&versionId=${modelVersionId}` : '';
  const r = await fetchImpl(`/api/training-studio/model-status?id=${modelId}${versionParam}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  const data = (await r.json().catch(() => null)) as { live?: unknown } | null;
  if (!r.ok || typeof data?.live !== 'boolean')
    throw new Error(`The model check failed (${r.status}).`);
  return data.live;
}
