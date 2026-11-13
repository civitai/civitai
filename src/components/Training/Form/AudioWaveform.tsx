import { ActionIcon } from '@mantine/core';
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import clsx from 'clsx';
import React, { useEffect, useMemo, useRef } from 'react';
import { useAudioPeaks } from '~/components/Audio/useAudioPeaks';
import { useMediaPlayback } from '~/components/Audio/useMediaPlayback';
import { formatPlaybackTime, timeFromPointer } from '~/utils/audio-player';

const WAVEFORM_BARS = 160;

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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const peaks = useAudioPeaks(src, buckets, containerRef);
  const {
    mediaRef,
    playing: isPlaying,
    currentTime,
    duration,
    progress,
    togglePlay,
    seekTo,
    mediaEvents,
  } = useMediaPlayback<HTMLAudioElement>();

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

  const onSeek = (e: React.MouseEvent<HTMLDivElement>) =>
    seekTo(timeFromPointer(e.clientX, e.currentTarget.getBoundingClientRect(), duration));

  // Keyboard seek for accessibility. Arrow keys move ±5s, shift modifier ±15s,
  // Home/End jump to start/end, Page keys do larger 30s steps. This matches
  // the spirit of an ARIA slider without forcing layout changes on the canvas.
  const onSeekKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const audio = mediaRef.current;
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
    seekTo(next);
  };

  const timeLabel = useMemo(
    () => `${formatPlaybackTime(currentTime)} / ${formatPlaybackTime(duration)}`,
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
      <audio ref={mediaRef} src={src} preload="metadata" {...mediaEvents} className="hidden" />
    </div>
  );
}

export default AudioWaveform;
