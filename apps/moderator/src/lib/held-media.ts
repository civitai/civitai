/** `/api/held-media` for one image; `full` opens the audited full-size view. */
export const heldMediaUrl = (imageId: number, full = false) =>
  `/api/held-media/${imageId}${full ? '?view=full' : ''}`;
