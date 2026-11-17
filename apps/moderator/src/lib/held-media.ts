export const heldMediaUrl = (imageId: number) => `/api/held-media/${imageId}`;

/** A blocked image from storage, for when the public CDN does not serve it. */
export const retractedMediaUrl = (imageId: number) => `/api/retracted-media/${imageId}`;

/** The grid's summary row for a page of held media. Best-effort: a lost row never blocks review. */
export function reportHeldGridView(count: number) {
  void fetch('/api/held-media/grid-view', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count }),
    keepalive: true,
  }).catch(() => null);
}
