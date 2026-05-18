import { ActionIcon } from '@mantine/core';
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import clsx from 'clsx';
import pLimit from 'p-limit';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const WAVEFORM_BARS = 160;

// Cap concurrent decodes — each one fetches the full source and holds a
// large decoded buffer in memory. Without this, a page with many WAVs can
// kick off N parallel fetches/decodes and pin a lot of memory at once.
const decodeLimit = pLimit(2);

// Persist computed peaks per source so re-mounting a card (pagination,
// scrolling in/out of view) doesn't trigger a second download+decode.
const peaksCache = new Map<string, number[] | null>();

const formatTime = (seconds: number) => {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

let cachedAudioContext: AudioContext | null = null;
const getAudioContext = () => {
  if (cachedAudioContext) return cachedAudioContext;
  const Ctx =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  cachedAudioContext = new Ctx();
  return cachedAudioContext;
};

/**
 * Decode the source audio into a fixed number of normalized peak values.
 * Skips decode if AudioContext is unavailable (older browsers / SSR) — caller
 * falls back to a flat bar UI.
 */
async function computePeaks(src: string, buckets: number): Promise<number[] | null> {
  const ctx = getAudioContext();
  if (!ctx) return null;

  const response = await fetch(src);
  if (!response.ok) return null;
  const arrayBuffer = await response.arrayBuffer();
  // decodeAudioData detaches the ArrayBuffer in Safari, so clone before.
  const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));

  const channel = decoded.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(channel.length / buckets));
  const peaks = new Array<number>(buckets).fill(0);
  for (let i = 0; i < buckets; i++) {
    const start = i * blockSize;
    let sum = 0;
    for (let j = 0; j < blockSize; j++) sum += Math.abs(channel[start + j] ?? 0);
    peaks[i] = sum / blockSize;
  }
  const max = Math.max(...peaks, 1e-6);
  return peaks.map((p) => p / max);
}

type AudioWaveformProps = {
  src: string;
  /** Optional class for the outer card wrapper. */
  className?: string;
  /** Height of the waveform canvas in px. */
  height?: number;
  /** Total number of bars to render. */
  buckets?: number;
};

export function AudioWaveform({
  src,
  className,
  height = 56,
  buckets = WAVEFORM_BARS,
}: AudioWaveformProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(() => peaksCache.get(src) ?? null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Gate decoding on visibility so off-screen cards (paginated lists, scrolled
  // areas) don't pull and decode the full audio file until they're in view.
  const [hasBeenVisible, setHasBeenVisible] = useState(() => peaksCache.has(src));

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
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setHasBeenVisible(true);
            observer.disconnect();
            return;
          }
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasBeenVisible]);

  // Decode peaks once per src. Failures (CORS, codec, no AudioContext) leave
  // peaks=null and the canvas falls back to evenly spaced bars. Decoding is
  // bounded by `decodeLimit` and skipped entirely until the card has been
  // visible at least once.
  useEffect(() => {
    if (!hasBeenVisible) return;
    if (peaksCache.has(src)) {
      setPeaks(peaksCache.get(src) ?? null);
      return;
    }
    let cancelled = false;
    setPeaks(null);
    decodeLimit(() => computePeaks(src, buckets))
      .then((p) => {
        peaksCache.set(src, p);
        if (!cancelled) setPeaks(p);
      })
      .catch(() => {
        peaksCache.set(src, null);
        if (!cancelled) setPeaks(null);
      });
    return () => {
      cancelled = true;
    };
  }, [src, buckets, hasBeenVisible]);

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  // Redraw whenever peaks, progress, or the canvas size change. We rasterize at
  // devicePixelRatio for crispness on retina; CSS keeps the layout size stable.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const data = peaks ?? new Array<number>(buckets).fill(0.25);
    const barCount = data.length;
    const gap = 1;
    const totalGap = gap * (barCount - 1);
    const barWidth = Math.max(1, (cssWidth - totalGap) / barCount);
    const midY = cssHeight / 2;
    const playedBars = Math.floor(progress * barCount);

    for (let i = 0; i < barCount; i++) {
      const amp = Math.max(0.06, data[i]);
      const h = amp * (cssHeight - 4);
      const x = i * (barWidth + gap);
      ctx.fillStyle = i <= playedBars ? '#3b82f6' : '#9ca3af';
      ctx.fillRect(x, midY - h / 2, barWidth, h);
    }
  }, [peaks, progress, buckets]);

  // Re-render the canvas on resize so the bars stretch with the container.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      // Trigger a draw via a setState — useEffect above depends on `progress` only,
      // so bump a noop state to force redraw. Simpler: dispatch a manual redraw.
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      const data = peaks ?? new Array<number>(buckets).fill(0.25);
      const barCount = data.length;
      const gap = 1;
      const totalGap = gap * (barCount - 1);
      const barWidth = Math.max(1, (canvas.clientWidth - totalGap) / barCount);
      const midY = canvas.clientHeight / 2;
      const playedBars = Math.floor(progress * barCount);
      for (let i = 0; i < barCount; i++) {
        const amp = Math.max(0.06, data[i]);
        const h = amp * (canvas.clientHeight - 4);
        const x = i * (barWidth + gap);
        ctx.fillStyle = i <= playedBars ? '#3b82f6' : '#9ca3af';
        ctx.fillRect(x, midY - h / 2, barWidth, h);
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [peaks, buckets, progress]);

  const onSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      if (!audio || !duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * duration;
      setCurrentTime(audio.currentTime);
    },
    [duration]
  );

  // Keyboard seek for accessibility. Arrow keys move ±5s, shift modifier ±15s,
  // Home/End jump to start/end, Page keys do larger 30s steps. This matches
  // the spirit of an ARIA slider without forcing layout changes on the canvas.
  const onSeekKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      if (!audio || !duration) return;
      const small = e.shiftKey ? 15 : 5;
      let next: number | null = null;
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          next = audio.currentTime - small;
          break;
        case 'ArrowRight':
        case 'ArrowUp':
          next = audio.currentTime + small;
          break;
        case 'PageDown':
          next = audio.currentTime - 30;
          break;
        case 'PageUp':
          next = audio.currentTime + 30;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = duration;
          break;
      }
      if (next === null) return;
      e.preventDefault();
      audio.currentTime = Math.max(0, Math.min(duration, next));
      setCurrentTime(audio.currentTime);
    },
    [duration]
  );

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  }, []);

  const timeLabel = useMemo(
    () => `${formatTime(currentTime)} / ${formatTime(duration)}`,
    [currentTime, duration]
  );

  const sliderValue = duration > 0 ? Math.round(progress * 100) : 0;

  return (
    <div
      ref={containerRef}
      className={clsx(
        'flex items-center gap-3 rounded-md border border-gray-3 bg-gray-0 px-3 py-2 dark:border-dark-4 dark:bg-dark-6',
        className
      )}
    >
      <ActionIcon
        variant="filled"
        color="blue"
        radius="xl"
        size="lg"
        onClick={togglePlay}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <IconPlayerPauseFilled size={18} /> : <IconPlayerPlayFilled size={18} />}
      </ActionIcon>
      {/*
        The container — not the canvas — is the focusable seek control. It
        carries ARIA slider semantics so screen readers announce position, and
        keyboard users can move with arrows / Home / End / Page keys. The
        canvas inside is purely visual.
      */}
      <div
        role="slider"
        tabIndex={duration > 0 ? 0 : -1}
        aria-label="Seek audio"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={sliderValue}
        aria-valuetext={timeLabel}
        onClick={onSeek}
        onKeyDown={onSeekKeyDown}
        className="h-full flex-1 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-5"
        style={{ height }}
      >
        <canvas ref={canvasRef} className="size-full" style={{ height }} aria-hidden="true" />
      </div>
      <span className="font-mono min-w-[72px] text-right text-xs text-gray-7 dark:text-dark-1">
        {timeLabel}
      </span>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        className="hidden"
      />
    </div>
  );
}

export default AudioWaveform;
