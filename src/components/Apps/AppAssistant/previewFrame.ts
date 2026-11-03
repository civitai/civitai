import { checkedEntryUrl, fetchEntryUrlBody } from '~/components/AppBlocks/devTunnelEntryUrl';
import type { DevTunnelFrame } from '~/server/services/blocks/dev-tunnel-frame.service';

const PREVIEW_UNAVAILABLE = 'The preview is unavailable';

export type PreviewFrame = DevTunnelFrame & { iframeSrc: string };
/** The tunnel is live but not resolvable yet, so there is no URL to frame. */
export type PreviewPreparing = { preparing: true };

/** civitai has no live tunnel for the block (it idled out, or was stopped): the preview is gone. */
export class PreviewGoneError extends Error {
  override name = 'PreviewGoneError';
}

/**
 * The preview pane's frame for `blockId`, with a freshly signed, short-lived entry URL (https, on
 * the frame's `host`) — or `{ preparing: true }` until the tunnel's host can be resolved.
 */
export async function fetchPreviewFrame(
  blockId: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): Promise<PreviewFrame | PreviewPreparing> {
  const data = await fetchEntryUrlBody(
    `/api/apps/assistant/preview?blockId=${encodeURIComponent(blockId)}`,
    fetchImpl,
    {
      fallback: PREVIEW_UNAVAILABLE,
      // 409: the app is the caller's, but no tunnel of it is live (`/api/apps/assistant/preview`).
      refuse: (status, body) =>
        status === 409 ? new PreviewGoneError(body?.error ?? PREVIEW_UNAVAILABLE) : undefined,
    }
  );
  if (data.preparing === true) return { preparing: true };
  checkedEntryUrl(data, PREVIEW_UNAVAILABLE);
  return data as unknown as PreviewFrame;
}

/**
 * Just a freshly signed entry URL for `blockId`'s preview, for the frame's Retry (which swaps it in
 * without remounting the host). Rejects when there is none to give: the preview is gone, or its
 * host is not resolvable yet.
 */
export async function fetchPreviewEntryUrl(
  blockId: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  const frame = await fetchPreviewFrame(blockId, fetchImpl);
  if ('preparing' in frame) throw new Error('The preview is not ready yet');
  return frame.iframeSrc;
}
