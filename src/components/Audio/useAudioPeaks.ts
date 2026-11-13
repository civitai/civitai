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

async function decodePeaks(
  src: string,
  buckets: number,
  signal: AbortSignal
): Promise<number[] | null> {
  // Still waiting for a slot when the caller went away.
  signal.throwIfAborted();
  const ctx = getAudioContext();
  if (!ctx) return null;
  const response = await fetch(src, { signal });
  if (!response.ok) return null;
  const arrayBuffer = await response.arrayBuffer();
  // decodeAudioData detaches the ArrayBuffer in Safari, so clone before.
  const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  return computeWaveformPeaks(decoded.getChannelData(0), buckets);
}

/**
 * The waveform peaks of the audio at `src`, decoded in the browser once the element behind
 * `containerRef` first comes near the viewport and `enabled` (default true) has been true for this
 * audio. Null while loading and whenever the audio cannot be fetched or decoded (CORS, codec, no
 * AudioContext), so callers draw a fallback instead. The download is cancelled on unmount and when
 * `src` changes.
 */
export function useAudioPeaks(
  src: string,
  buckets: number,
  containerRef: RefObject<HTMLElement | null>,
  { enabled = true }: { enabled?: boolean } = {}
) {
  const key = `${buckets}:${src}`;
  const [peaks, setPeaks] = useState<number[] | null>(() => peaksCache.get(key) ?? null);
  const [hasBeenVisible, setHasBeenVisible] = useState(() => peaksCache.has(key));
  // Once enabled for this audio, a decode keeps going when `enabled` turns off again.
  const [enabledKey, setEnabledKey] = useState(enabled ? key : null);
  if (enabled && enabledKey !== key) setEnabledKey(key);
  const allowed = enabledKey === key;

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
    setPeaks(null);
    if (!allowed) return;
    const controller = new AbortController();
    const { signal } = controller;
    decodeLimit(() => decodePeaks(src, buckets, signal))
      .then((p) => {
        peaksCache.set(key, p);
        if (!signal.aborted) setPeaks(p);
      })
      .catch(() => {
        // A cancelled download is not a failed one: the next mount tries again.
        if (signal.aborted) return;
        peaksCache.set(key, null);
        setPeaks(null);
      });
    return () => controller.abort();
  }, [key, src, buckets, hasBeenVisible, allowed]);

  return peaks;
}
