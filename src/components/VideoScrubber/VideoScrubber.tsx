import { useRef, useEffect, useMemo, useState } from 'react';
import { videoFramesToCanvasArray } from './videoScrubber.utils';

import { useScrubberStore } from '~/components/VideoScrubber/scrubber.store';
import { Slider } from '@mantine/core';

// todo: add wait animation while 'videoFramesToCanvasArray' is resolving.
export function VideoScrubber({ src, width, height, duration, canvasWidth }: Props) {
  const [canvasFrames, setCanvasFrames] = useState<Array<HTMLCanvasElement>>([]);
  const { currentScrubberFrame, scrubberFramesMax } = useScrubberStore((state) => state.scrubber);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // todo: move to scrubberSlice
  //const [canvasFrames, setCanvasFrames] = useState<Array<HTMLCanvasElement>>([]);
  // Create array of temporal offsets into video by dividing its duration
  // by the number of video frame samples that can be scrubbed.
  // The more frame samples, the smoother the scrubbing.
  const currentTimes = useMemo<Array<number>>(() => {
    const timeIncrement: number = duration / scrubberFramesMax;
    // pre-allocation has better performance than pushing
    const currentTimes: Array<number> = new Array(scrubberFramesMax);
    for (let i = 0; i < currentTimes.length; i++) currentTimes[i] = i * timeIncrement + 0.1;
    return currentTimes;
  }, [duration, scrubberFramesMax]);

  // Create an array of canvas elements, each holding a frame of video
  // that corresponds to a temporal offset in the 'currentTimes' array.
  useEffect(() => {
    videoFramesToCanvasArray(src, currentTimes, width, canvasWidth).then(setCanvasFrames);
  }, [src, currentTimes, width, height, canvasWidth]);

  useEffect(() => {
    if (canvasRef.current !== null && canvasFrames.length) {
      const ctx = canvasRef.current.getContext('2d');
      ctx?.drawImage(canvasFrames[currentScrubberFrame], 0, 0);
    }
  }, [canvasFrames, currentScrubberFrame]);

  return (
    <div className="flex flex-col items-center justify-center gap-2">
      <canvas ref={canvasRef} width={canvasWidth} height={canvasWidth} />
      <ScrubberSlider />
    </div>
  );
}

type Props = {
  src: string;
  width: number;
  height: number;
  duration: number;
  canvasWidth: number;
};

function ScrubberSlider() {
  const { currentScrubberFrame, scrubberFramesMax } = useScrubberStore((state) => state.scrubber);
  const setScrubberState = useScrubberStore((state) => state.setScrubberState);

  return (
    <div className="w-full">
      <Slider
        min={0}
        max={scrubberFramesMax - 1}
        step={1}
        defaultValue={currentScrubberFrame}
        onChange={(value) => setScrubberState({ currentScrubberFrame: value })}
      />
    </div>
  );
}
