import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { create } from 'zustand';

type ScrubberState = {
  currentScrubberFrame: number;
  scrubberFramesMax: number;
  canvasWidth: number;
};

type VideoState = {
  src: string;
  duration: number;
  width: number;
  height: number;
};

type ScrubberStoreState = {
  video: VideoState;
  scrubber: ScrubberState;
  setVideoState: (video: Partial<VideoState>) => void;
  setScrubberState: (scrubber: Partial<ScrubberState>) => void;
  reset: VoidFunction;
};

const scrubberFramesMaxDefault = 20;
export const useScrubberStore = create<ScrubberStoreState>()(
  devtools(
    immer((set) => ({
      video: {
        src: '',
        duration: 0,
        width: 0,
        height: 0,
      },
      scrubber: {
        currentScrubberFrame: Math.floor(scrubberFramesMaxDefault / 2),
        scrubberFramesMax: scrubberFramesMaxDefault,
        canvasWidth: 0,
      },
      setVideoState: (video) =>
        set((state) => {
          state.video = { ...state.video, ...video };
        }),
      setScrubberState: (scrubber) =>
        set((state) => {
          state.scrubber = { ...state.scrubber, ...scrubber };
        }),
      reset: () =>
        set(() => ({
          video: { src: '', duration: 0, width: 0, height: 0 },
          scrubber: { currentScrubberFrame: 0, scrubberFramesMax: 0, canvasWidth: 0 },
        })),
    }))
  )
);
