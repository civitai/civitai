import type { DevTunnelFrame } from '~/server/services/blocks/dev-tunnel-frame.service';

export type PreviewFrame = DevTunnelFrame & { iframeSrc: string };

/** The preview pane's frame for `blockId`, with a freshly signed, short-lived entry URL. */
export async function fetchPreviewFrame(
  blockId: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): Promise<PreviewFrame> {
  const res = await fetchImpl(
    `/api/apps/assistant/preview?blockId=${encodeURIComponent(blockId)}`,
    {
      credentials: 'same-origin',
    }
  );
  const data = (await res.json().catch(() => null)) as (PreviewFrame & { error?: string }) | null;
  if (!res.ok || !data?.iframeSrc) throw new Error(data?.error ?? 'The preview is unavailable');
  return data;
}
