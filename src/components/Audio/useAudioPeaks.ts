import pLimit from 'p-limit';
import type { RefObject } from 'react';
import { useEffect, useState } from 'react';
import { computeWaveformPeaks } from '~/utils/audio-player';

// Each decode fetches the whole file and holds the decoded buffer in memory; a page with many
// tracks would otherwise start all of them at once.
const decodeLimit = pLimit(2);

// Remounting a card (pagination, scrolling in and out) must not download and decode again.
const peaksCache = new Map<string, number[] | null>();

let cachedAudioContext: AudioContext | null = null;
function getAudioContext() {
  if (cachedAudioContext) return cachedAudioContext;
  const Ctx =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  cachedAudioContext = new Ctx();
  return cachedAudioContext;
}

async function decodePeaks(src: string, buckets: number): Promise<number[] | null> {
  const ctx = getAudioContext();
  if (!ctx) return null;
  const response = await fetch(src);
  if (!response.ok) return null;
  const arrayBuffer = await response.arrayBuffer();
  // decodeAudioData detaches the ArrayBuffer in Safari, so clone before.
  const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  return computeWaveformPeaks(decoded.getChannelData(0), buckets);
}

/**
 * The waveform peaks of the audio at `src`, decoded in the browser once the element behind
 * `containerRef` first comes near the viewport. Null while loading and whenever the audio cannot
 * be fetched or decoded (CORS, codec, no AudioContext), so callers draw a fallback instead.
 */
export function useAudioPeaks(
  src: string,
  buckets: number,
  containerRef: RefObject<HTMLElement | null>
) {
  const key = `${buckets}:${src}`;
  const [peaks, setPeaks] = useState<number[] | null>(() => peaksCache.get(key) ?? null);
  const [hasBeenVisible, setHasBeenVisible] = useState(() => peaksCache.has(key));

  useEffect(() => {
    if (hasBeenVisible) return;
    const node = containerRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setHasBeenVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setHasBeenVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasBeenVisible, containerRef]);

  useEffect(() => {
    if (!hasBeenVisible) return;
    if (peaksCache.has(key)) {
      setPeaks(peaksCache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    setPeaks(null);
    decodeLimit(() => decodePeaks(src, buckets))
      .then((p) => {
        peaksCache.set(key, p);
        if (!cancelled) setPeaks(p);
      })
      .catch(() => {
        peaksCache.set(key, null);
        if (!cancelled) setPeaks(null);
      });
    return () => {
      cancelled = true;
    };
  }, [key, src, buckets, hasBeenVisible]);

  return peaks;
}
