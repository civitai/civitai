/**
 * Where a tour should scroll its target.
 *
 * Centering suits a button or a heading, but a target that wraps a whole
 * section is taller than the viewport, and centering it leaves the user
 * halfway down the section rather than at the thing the step describes —
 * `(height - viewport) / 2` past its top, which for a full model gallery is
 * hundreds of images.
 */
export function tourScrollBlock(
  targetHeight: number,
  viewportHeight: number
): ScrollLogicalPosition {
  return targetHeight > viewportHeight ? 'start' : 'center';
}
