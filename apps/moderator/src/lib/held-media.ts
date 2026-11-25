export const heldMediaUrl = (imageId: number) => `/api/held-media/${imageId}`;

/** A blocked image from storage, for when the public CDN does not serve it. */
export const retractedMediaUrl = (imageId: number) => `/api/retracted-media/${imageId}`;

/** What a tile shows when `/api/retracted-media` refuses. Every 404 reads the same, whatever the
 *  route's reason, so a refusal for a CSAM signal cannot be told apart from any other. */
export const RETRACTED_REFUSED =
  'Not viewable here. It may need CSAM-queue access or be unavailable; ask a lead.';

/** The refusal shown, and returned by image actions, when the image is withheld from this
 *  moderator. Names no reason. */
export const WITHHELD_REFUSED = 'Not ruled on here. Ask a lead.';

/** What a tile shows when the route has no file to serve for this image by its own facts
 *  (`moderatorMediaUnavailable`). */
export const RETRACTED_UNAVAILABLE =
  'Not available: the file may be deleted, or not stored for this image.';

/** What a tile shows for an image whose upload never finished processing. */
export const MEDIA_UNPROCESSED =
  'This file did not finish processing, so there is nothing to show.';

/** Asks the route why it refused an image, without serving it, and returns the tile's line. */
export async function probeRetractedRefusal(imageId: number): Promise<string> {
  const res = await fetch(`${retractedMediaUrl(imageId)}?probe=1`);
  return retractedRefusalReason(res.status, await res.json().catch(() => null));
}

/** The tile's line for a refused probe: the route's own message on a 403 or 503, which a moderator
 *  can act on, `RETRACTED_UNAVAILABLE` when the route says so, and the one generic line otherwise. */
export function retractedRefusalReason(status: number, body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (status === 404 && message === RETRACTED_UNAVAILABLE) return RETRACTED_UNAVAILABLE;
  if (status !== 403 && status !== 503) return RETRACTED_REFUSED;
  return typeof message === 'string' && message ? message : RETRACTED_REFUSED;
}

/** The grid's summary row for a page of held media. Best-effort: a lost row never blocks review. */
export function reportHeldGridView(count: number) {
  void fetch('/api/held-media/grid-view', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count }),
    keepalive: true,
  }).catch(() => null);
}
