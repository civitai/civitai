import type { DevTunnelFrame } from '~/server/services/blocks/dev-tunnel-frame.service';

export type PreviewFrame = DevTunnelFrame & { iframeSrc: string };
/** The tunnel is live but not resolvable yet, so there is no URL to frame. */
export type PreviewPreparing = { preparing: true };

/** civitai has no live tunnel for the block (it idled out, or was stopped): the preview is gone. */
export class PreviewGoneError extends Error {
  override name = 'PreviewGoneError';
}

/**
 * The preview pane's frame for `blockId`, with a freshly signed, short-lived entry URL — or
 * `{ preparing: true }` until the tunnel's host can be resolved.
 */
export async function fetchPreviewFrame(
  blockId: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): Promise<PreviewFrame | PreviewPreparing> {
  const res = await fetchImpl(
    `/api/apps/assistant/preview?blockId=${encodeURIComponent(blockId)}`,
    {
      credentials: 'same-origin',
    }
  );
  const data = (await res.json().catch(() => null)) as
    | (Partial<PreviewFrame & PreviewPreparing> & { error?: string })
    | null;
  if (res.ok && data?.preparing === true) return { preparing: true };
  // 409: the app is the caller's, but no tunnel of it is live (`/api/apps/assistant/preview`).
  if (res.status === 409) throw new PreviewGoneError(data?.error ?? 'The preview is unavailable');
  if (!res.ok || !data?.iframeSrc) throw new Error(data?.error ?? 'The preview is unavailable');
  return data as PreviewFrame;
}
