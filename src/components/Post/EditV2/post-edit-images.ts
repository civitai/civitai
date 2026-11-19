import type { ControlledImage } from '~/components/Post/EditV2/PostEditProvider';

/** Only saved ('added') images are deduped; in-progress tiles have no stable id yet. */
export function dedupeAddedImages(images: ControlledImage[]): ControlledImage[] {
  const seen = new Set<number>();
  return images.filter((image) => {
    if (image.type !== 'added') return true;
    if (seen.has(image.data.id)) return false;
    seen.add(image.data.id);
    return true;
  });
}
