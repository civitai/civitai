import type { ShownAction, ShownRendition } from '@civitai/shared/held-media';

const pending = new Set<Promise<unknown>>();

/** One image the report page put on screen and the moderator then opened or selected. Best-effort:
 *  a row that never lands only leaves the image unrecorded. */
export function recordShown(body: {
  imageId: number;
  userId: number;
  action: ShownAction;
  rendition: ShownRendition;
}) {
  const sending: Promise<unknown> = fetch('/api/mod/held-media/shown', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  })
    .catch(() => null)
    .finally(() => pending.delete(sending));
  pending.add(sending);
}

/** Settles once every row sent so far has landed or failed, or after `waitMs`, so a filing made now
 *  follows them without a stalled request holding it. */
export const settleShown = (waitMs = 3000) =>
  Promise.race([
    Promise.allSettled([...pending]),
    new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
  ]);
