/**
 * The rating the image page gates on. A contest's forced level applies only when the server sent
 * the media: a null `url` means it was withheld from this viewer, so the page gates on the
 * image's own rating and shows the gate card instead of an empty frame.
 */
export function imageDetailGateLevel(
  image: { url: string | null; nsfwLevel: number },
  forcedBrowsingLevel?: number | null
) {
  return (image.url && forcedBrowsingLevel) || image.nsfwLevel;
}
