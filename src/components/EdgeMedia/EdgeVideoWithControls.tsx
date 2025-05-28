import type { ReactEventHandler } from 'react';
import { MouseEventHandler, forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { EdgeVideoBaseProps } from '~/components/EdgeMedia/EdgeVideoBase';
import { EdgeVideoBase } from '~/components/EdgeMedia/EdgeVideoBase';
import clsx from 'clsx';
import { useLocalStorage } from '@mantine/hooks';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/*
  TODO

  - [ ] make so that only one video can be playing at any given time
      [ ] post details page should be able to set the active video based on scroll position
  - [ ] pause any actively playing video when the window loses focus
  - [ ] determine if/when to use mouse enter/leave events
        - only have it for feed views (preview mode?)
*/

const EdgeVideoWithControls = forwardRef<HTMLVideoElement, EdgeVideoBaseProps>(
  ({ ...props }, forwardedRef) => {
    const [isPlaying, setIsPlaying] = useState(false);

    const volume = useVideoPlayerStore((state) => state.volume);
    const muted = useVideoPlayerStore((state) => state.muted);

    const handleVolumeChange: ReactEventHandler<HTMLVideoElement> = (e) => {
      useVideoPlayerStore.setState({
        volume: e.currentTarget.volume,
        muted: e.currentTarget.muted,
      });
    };

    const handleLoadedData: ReactEventHandler<HTMLVideoElement> = (e) => {
      e.currentTarget.volume = volume;
    };

    // const handleMouseEnter: MouseEventHandler<HTMLVideoElement> = (e) => {
    //   e.currentTarget.play();
    // };

    // const handleMouseLeave: MouseEventHandler<HTMLVideoElement> = (e) => {
    //   e.currentTarget.pause();
    // };

    return (
      <div className={clsx(`relative flex items-center justify-center`)}>
        <EdgeVideoBase
          ref={forwardedRef}
          {...props}
          muted={muted}
          onPlaying={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onVolumeChange={handleVolumeChange}
          onLoadedData={handleLoadedData}
          autoPlay={props.options?.anim}
          // onMouseEnter={handleMouseEnter}
          // onMouseLeave={handleMouseLeave}
          controls
        />
      </div>
    );
  }
);

EdgeVideoWithControls.displayName = 'EdgeVideoWithControls';

const useVideoPlayerStore = create<{ muted: boolean; volume: number }>()(
  persist((set) => ({ muted: true, volume: 0.5 }), { name: 'video-player' })
);
