/** A playback position or length in seconds as `m:ss`; an unknown or negative time reads `0:00`. */
export function formatPlaybackTime(seconds: number) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * `buckets` loudness values in 0..1 for one decoded channel: the mean absolute sample of each
 * equal slice, scaled so the loudest slice reads 1. Samples past the last whole slice are left
 * out; a slice past the end of the input, or silence, reads 0.
 */
export function computeWaveformPeaks(samples: ArrayLike<number>, buckets: number): number[] {
  const blockSize = Math.max(1, Math.floor(samples.length / buckets));
  const peaks = new Array<number>(buckets).fill(0);
  for (let i = 0; i < buckets; i++) {
    const start = i * blockSize;
    let sum = 0;
    for (let j = 0; j < blockSize; j++) sum += Math.abs(samples[start + j] ?? 0);
    peaks[i] = sum / blockSize;
  }
  const max = Math.max(...peaks, 1e-6);
  return peaks.map((p) => p / max);
}
