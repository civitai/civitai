/**
 * The embedded Training Studio's `autoLabel` host hooks: this app's system-paid auto-label routes.
 * Any non-2xx rejects with the route's reason, so the element marks the batch failed.
 */
export const studioAutoLabel = {
  submit: (body: unknown, fetchImpl: typeof fetch = fetch) =>
    request<{ workflowId: string }>(fetchImpl, '/api/training-studio/auto-label', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  poll: (workflowId: string, fetchImpl: typeof fetch = fetch) =>
    request<unknown>(
      fetchImpl,
      `/api/training-studio/auto-label/${encodeURIComponent(workflowId)}`
    ),
};

async function request<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const r = await fetchImpl(url, { ...init, redirect: 'error' });
  const data = (await r.json().catch(() => null)) as
    | (T & { message?: string; error?: string })
    | null;
  if (!r.ok || !data)
    throw new Error(data?.message ?? data?.error ?? `Auto-labeling failed (${r.status}).`);
  return data;
}
