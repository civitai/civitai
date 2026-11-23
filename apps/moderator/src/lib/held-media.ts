export const heldMediaUrl = (imageId: number) => `/api/held-media/${imageId}`;

/** A blocked image from storage, for when the public CDN does not serve it. */
export const retractedMediaUrl = (imageId: number) => `/api/retracted-media/${imageId}`;

/** What a tile shows when `/api/retracted-media` refuses. Every 404 reads the same, whatever the
 *  route's reason, so a refusal for a CSAM signal cannot be told apart from any other. */
export const RETRACTED_REFUSED =
  'Not viewable here. It may need CSAM-queue access or be unavailable; ask a lead.';

/** What an appeal card shows in place of the ruling form, and the image actions that check it answer, when the
 *  image is kept from this moderator. It names no reason. */
export const APPEAL_RULING_REFUSED = 'Not ruled on here. Ask a lead.';

/** Asks the route why it refused an image, without serving it, and returns the tile's line. */
export async function probeRetractedRefusal(imageId: number): Promise<string> {
  const res = await fetch(`${retractedMediaUrl(imageId)}?probe=1`);
  return retractedRefusalReason(res.status, await res.json().catch(() => null));
}

/** The tile's line for a refused probe: the route's own message on a 403 or 503, which a moderator
 *  can act on, and the one generic line for anything else. */
export function retractedRefusalReason(status: number, body: unknown): string {
  if (status !== 403 && status !== 503) return RETRACTED_REFUSED;
  const message = (body as { message?: unknown } | null)?.message;
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
