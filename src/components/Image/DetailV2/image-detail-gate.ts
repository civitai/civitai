/**
 * The rating the image page gates on. A contest's forced level applies only when the server sent
 * the media (non-null `url`); otherwise gate on the image's own rating.
 */
export function imageDetailGateLevel(
  image: { url: string | null; nsfwLevel: number },
  forcedBrowsingLevel?: number | null
) {
  return (image.url && forcedBrowsingLevel) || image.nsfwLevel;
}
