const NO_CAPTIONS = new Map<number, string>();

/**
 * The captions the author has already saved on this post's images, by image id. Returns none until
 * `storyline.getPostImageCaptions` ships; the caption box is wired to this one seam.
 */
export function usePostImageCaptions(_postId: number) {
  return { captions: NO_CAPTIONS, isLoading: false };
}
