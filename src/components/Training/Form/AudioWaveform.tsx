import { ActionIcon } from '@mantine/core';
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import clsx from 'clsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const WAVEFORM_BARS = 160;

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
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Decode peaks once per src. Failures (CORS, codec, no AudioContext) leave
  // peaks=null and the canvas falls back to evenly spaced bars.
  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    computePeaks(src, buckets)
      .then((p) => {
        if (!cancelled) setPeaks(p);
      })
      .catch(() => {
        if (!cancelled) setPeaks(null);
      });
    return () => {
      cancelled = true;
    };
  }, [src, buckets]);

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
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const audio = audioRef.current;
      if (!canvas || !audio || !duration) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * duration;
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

  return (
    <div
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
      <canvas
        ref={canvasRef}
        onClick={onSeek}
        className="h-full flex-1 cursor-pointer"
        style={{ height }}
      />
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
