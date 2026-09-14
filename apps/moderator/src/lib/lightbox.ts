/**
 * One frame in a lightbox. `id` is a Cloudflare-images key — NEVER a URL; see the caller-side note
 * on `feedbackAttachmentItems`.
 */
export type LightboxItem = {
  id: string;
  /** Shown under the large view. Carries provenance, so it is not decoration — see the note there. */
  caption: string;
};

/**
 * Wrapping index step for arrow-key paging.
 *
 * Wraps rather than clamping: a moderator paging through three attachments should not have to know
 * which end they are at, and the set is never long enough for wrapping to be disorienting.
 *
 * The double modulo is what makes `-1` land on the LAST item — JavaScript's `%` keeps the sign of
 * the dividend, so a single `%` returns `-1` and indexes off the end of the array.
 *
 * `length <= 0` returns 0 rather than `NaN`: the caller is expected not to open an empty lightbox,
 * but `NaN` propagates into an `<img src>` and a bad index does not.
 */
export function stepLightboxIndex(index: number, delta: number, length: number): number {
  if (!Number.isFinite(length) || length <= 0) return 0;
  if (!Number.isFinite(index) || !Number.isFinite(delta)) return 0;
  return (((index + delta) % length) + length) % length;
}
