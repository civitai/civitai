/** The host half of the element's `modelLive`: whether the run's model still exists for the caller. */
export async function checkStudioModelLive(
  modelId: number,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const r = await fetchImpl(`/api/training-studio/model-status?id=${modelId}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  const data = (await r.json().catch(() => null)) as { live?: unknown } | null;
  if (!r.ok || typeof data?.live !== 'boolean')
    throw new Error(`The model check failed (${r.status}).`);
  return data.live;
}
