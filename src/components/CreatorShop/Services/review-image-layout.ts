export type ReviewImageLayout = 'single' | 'row' | 'grid';

/** A review holds at most 4 images. One is a capped tile, 2-3 share an uncropped row, 4 a grid. */
export function reviewImageLayout(count: number): ReviewImageLayout {
  if (count <= 1) return 'single';
  if (count <= 3) return 'row';
  return 'grid';
}

/** A row tile takes width in proportion to its own shape, so every image shows whole. */
export function reviewRowTileStyle(image: { width?: number | null; height?: number | null }) {
  const ratio = image.width && image.height ? image.width / image.height : 1;
  return { aspectRatio: String(ratio), flex: `${ratio} 1 0` };
}
