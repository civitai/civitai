import type { PointerEvent, SyntheticEvent } from 'react';
import { useRef, useState } from 'react';
import { clampPlaybackTime, playbackProgress, timeFromPointer } from '~/utils/audio-player';

/**
 * Plays `media` when it is paused and pauses it when it plays. A refused play (no user gesture,
 * an unplayable source) is dropped: the element's own events keep the caller's state right.
 */
export function togglePlayback(media: HTMLMediaElement) {
  if (media.paused) media.play().catch(() => undefined);
  else media.pause();
}

/**
 * Play/pause, mute, seeking and the time bookkeeping of one inline `<audio>` or `<video>`: attach
 * `mediaRef` and `mediaEvents` to the element and `scrubHandlers` to the seek bar. The length
 * starts at `initialDuration` and is replaced by the element's own once its metadata loads.
 */
export function useMediaPlayback<T extends HTMLMediaElement = HTMLMediaElement>(
  initialDuration?: number | null
) {
  const mediaRef = useRef<T>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(initialDuration ?? 0);

  const togglePlay = () => {
    const media = mediaRef.current;
    if (media) togglePlayback(media);
  };

  const toggleMute = () => {
    const media = mediaRef.current;
    if (!media) return;
    media.muted = !media.muted;
    setMuted(media.muted);
  };

  const seekTo = (time: number) => {
    const media = mediaRef.current;
    if (!media || !(duration > 0)) return;
    const next = clampPlaybackTime(time, duration);
    media.currentTime = next;
    setCurrentTime(next);
  };

  const seekFromPointer = (e: PointerEvent<HTMLElement>) =>
    seekTo(timeFromPointer(e.clientX, e.currentTarget.getBoundingClientRect(), duration));

  const scrubHandlers = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      seekFromPointer(e);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (e.buttons === 1) seekFromPointer(e);
    },
  };

  const mediaEvents = {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: (e: SyntheticEvent<HTMLMediaElement>) =>
      setCurrentTime(e.currentTarget.currentTime),
    onLoadedMetadata: (e: SyntheticEvent<HTMLMediaElement>) => {
      if (isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
    },
  };

  return {
    mediaRef,
    playing,
    muted,
    currentTime,
    duration,
    /** The played fraction, `0..1`. */
    progress: playbackProgress(currentTime, duration),
    togglePlay,
    toggleMute,
    seekTo,
    scrubHandlers,
    mediaEvents,
  };
}
