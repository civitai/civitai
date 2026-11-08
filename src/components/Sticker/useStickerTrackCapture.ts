import { useEffect, useRef, useState } from 'react';
import type { StickerRecording } from '~/components/Sticker/sticker-recording';
import {
  beginTake,
  captureTo,
  RECORDING_BEAT_EVERY,
  RECORDING_MAX_TICKS,
  recordingPoseAt,
  recordingTick,
} from '~/components/Sticker/sticker-recording';
import type { StickerTrackSample } from '~/shared/utils/sticker-track';

export type CapturePhase = 'idle' | 'countdown' | 'recording';

const COUNTDOWN_FROM = 3;
const TICK_SOUND_KEY = 'sticker-recorder-tick';

const readTickSound = () => {
  try {
    return localStorage.getItem(TICK_SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
};

/**
 * Runs `onFrame` on each presented video frame, or each animation frame where those are missing,
 * until it returns `false` or the returned stop is called.
 */
function frameLoop(video: HTMLVideoElement, onFrame: () => boolean | void) {
  let frame = 0;
  const usesVideoFrames = typeof video.requestVideoFrameCallback === 'function';
  const next = () => {
    if (onFrame() === false) return;
    frame = usesVideoFrames ? video.requestVideoFrameCallback(next) : requestAnimationFrame(next);
  };
  next();
  return () => {
    if (usesVideoFrames) video.cancelVideoFrameCallback(frame);
    else cancelAnimationFrame(frame);
  };
}

/**
 * Records a draft's movement against the video: a countdown, then the video plays and every tick
 * captures the pose the placer is holding. Between takes the draft follows what was recorded.
 */
export function useStickerTrackCapture({
  video,
  recording,
  pose,
  onRecording,
  onPose,
  onCapturing,
}: {
  video: HTMLVideoElement;
  recording: StickerRecording;
  /** The draft's pose right now, read on every capture. */
  pose: () => StickerTrackSample;
  onRecording: (recording: StickerRecording) => void;
  onPose: (pose: StickerTrackSample) => void;
  /** Told when a countdown or take starts and ends, so nothing places mid-take. */
  onCapturing?: (capturing: boolean) => void;
}) {
  const [phase, setPhase] = useState<CapturePhase>('idle');
  const [count, setCount] = useState(COUNTDOWN_FROM);
  const [beat, setBeat] = useState(0);
  const [tickSound, setTickSoundState] = useState(readTickSound);

  const latest = useRef({ recording, pose, onRecording, onPose, onCapturing, tickSound });
  latest.current = { recording, pose, onRecording, onPose, onCapturing, tickSound };

  const take = useRef<StickerRecording>([]);
  const audio = useRef<AudioContext | null>(null);
  const finish = useRef<(() => void) | null>(null);

  const click = () => {
    const context = audio.current;
    if (!context || !latest.current.tickSound) return;
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.frequency.value = 1200;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.04);
    tone.connect(gain).connect(context.destination);
    tone.start();
    tone.stop(context.currentTime + 0.05);
  };

  useEffect(() => {
    latest.current.onCapturing?.(phase !== 'idle');
  }, [phase]);

  useEffect(() => {
    return () => {
      void audio.current?.close();
      latest.current.onCapturing?.(false);
    };
  }, []);

  useEffect(() => {
    if (phase !== 'countdown') return;
    if (count === 0) {
      setPhase('recording');
      return;
    }
    const timer = setTimeout(() => setCount(count - 1), 1000);
    return () => clearTimeout(timer);
  }, [phase, count]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const start = recordingTick(video.currentTime * 1000);
    take.current = beginTake(latest.current.recording, start, latest.current.pose());
    let lastTick = start;
    let captures = 0;
    let stopLoop: () => void = () => undefined;

    const end = () => {
      finish.current = null;
      stopLoop();
      video.removeEventListener('ended', done);
    };
    const done = () => {
      end();
      latest.current.onRecording([...take.current]);
      setPhase('idle');
    };
    finish.current = done;

    stopLoop = frameLoop(video, () => {
      const tick = recordingTick(video.currentTime * 1000);
      // Backwards is the video looping or being seeked: the take is over.
      if (tick < lastTick) {
        done();
        return false;
      }
      lastTick = tick;
      const captured = captureTo(take.current, tick, latest.current.pose());
      for (let i = 0; i < captured; i++) {
        captures++;
        if (captures % RECORDING_BEAT_EVERY === 0) {
          setBeat((value) => value + 1);
          click();
        }
      }
      if (take.current.length >= RECORDING_MAX_TICKS) {
        video.pause();
        done();
        return false;
      }
    });
    video.addEventListener('ended', done);
    void video.play();

    // Unmounting mid-take is the placer leaving the mode or the draft: the take is dropped, not
    // committed, or it would come back on a draft that has moved on.
    return () => {
      if (!finish.current) return;
      end();
      video.pause();
    };
    // The take reads everything else through `latest`; only a new video or phase starts one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, video]);

  // Between takes, the draft follows its recording as the video plays and seeks. A pose only moves
  // when the tick under the playhead changes, so an adjustment made while paused holds until then.
  const hasRecording = recording.length > 0;
  useEffect(() => {
    if (phase !== 'idle' || !hasRecording) return;
    let shown: StickerTrackSample | undefined;
    const update = () => {
      const next = recordingPoseAt(latest.current.recording, video.currentTime * 1000);
      if (!next || next === shown) return;
      shown = next;
      latest.current.onPose(next);
    };
    const stopLoop = frameLoop(video, update);
    video.addEventListener('seeked', update);
    video.addEventListener('timeupdate', update);
    return () => {
      stopLoop();
      video.removeEventListener('seeked', update);
      video.removeEventListener('timeupdate', update);
    };
  }, [phase, hasRecording, video]);

  return {
    phase,
    count,
    /** Goes up on every beat, for the flash that marks it. */
    beat,
    tickSound,
    setTickSound: (on: boolean) => {
      setTickSoundState(on);
      try {
        localStorage.setItem(TICK_SOUND_KEY, on ? 'on' : 'off');
      } catch {
        // A blocked storage only loses the preference.
      }
    },
    /** Counts down, then records from the playhead on. */
    record: () => {
      if (phase !== 'idle') return;
      // Created inside the press: browsers only let a gesture start audio.
      if (!audio.current && typeof AudioContext !== 'undefined') audio.current = new AudioContext();
      video.pause();
      setCount(COUNTDOWN_FROM);
      setPhase('countdown');
    },
    /** Stops the video and the take, keeping what was captured. */
    pause: () => {
      video.pause();
      if (phase === 'countdown') setPhase('idle');
      finish.current?.();
    },
    /** Ends the take and plays the result from the start. */
    stop: () => {
      if (phase === 'countdown') setPhase('idle');
      finish.current?.();
      video.currentTime = 0;
      void video.play();
    },
  };
}
