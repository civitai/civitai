/** Stable per image, so an image never changes pool between harvests. */
export function poolFor(imageId: number, hiddenCheckShare: number): 'trials' | 'hiddenCheck' {
  const hash = Math.imul(imageId ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return hash / 4294967296 < hiddenCheckShare ? 'hiddenCheck' : 'trials';
}
