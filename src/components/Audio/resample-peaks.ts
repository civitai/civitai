/**
 * `peaks` reduced to `count` bars, each the loudest of the peaks it covers, so a short burst
 * survives the reduction. Returns `peaks` itself when it has `count` or fewer.
 */
export function resamplePeaks(peaks: number[], count: number): number[] {
  if (count <= 0) return [];
  if (peaks.length <= count) return peaks;
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * peaks.length) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / count));
    let loudest = 0;
    for (let j = start; j < end; j++) loudest = Math.max(loudest, peaks[j]);
    bars.push(loudest);
  }
  return bars;
}
