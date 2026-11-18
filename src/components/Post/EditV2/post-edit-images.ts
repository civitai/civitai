import type { ControlledImage } from '~/components/Post/EditV2/PostEditProvider';

/** One tile per saved image: a repeat of the same image id is dropped, the first stays in place. */
export function dedupeAddedImages(images: ControlledImage[]): ControlledImage[] {
  const seen = new Set<number>();
  return images.filter((image) => {
    if (image.type !== 'added') return true;
    if (seen.has(image.data.id)) return false;
    seen.add(image.data.id);
    return true;
  });
}
