/** A freshly signed dev-tunnel entry URL and the host it is on. */
export interface DevTunnelEntryUrl {
  iframeSrc: string;
  host: string;
}

/**
 * A freshly signed entry URL for the caller's own `blockId` over its live dev tunnel, from
 * `/api/apps/dev/entry-url` (the `/apps/dev/<blockId>` page's gates). Rejects when there is none
 * to give — the app is not the caller's, no tunnel is live, its host is not published yet — or when
 * the URL's origin is not the host the answer names.
 */
export async function fetchDevTunnelEntryUrl(
  blockId: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): Promise<DevTunnelEntryUrl> {
  const res = await fetchImpl(`/api/apps/dev/entry-url?blockId=${encodeURIComponent(blockId)}`, {
    credentials: 'same-origin',
  });
  const data = (await res.json().catch(() => null)) as
    | (Partial<DevTunnelEntryUrl> & { error?: string })
    | null;
  if (!res.ok || !data?.iframeSrc || !data.host)
    throw new Error(data?.error ?? 'No fresh entry URL is available');
  let url: URL;
  try {
    url = new URL(data.iframeSrc);
  } catch {
    throw new Error('The fresh entry URL is malformed');
  }
  if (url.protocol !== 'https:' || url.host !== data.host)
    throw new Error('The fresh entry URL is not on its tunnel host');
  return { iframeSrc: data.iframeSrc, host: data.host };
}
