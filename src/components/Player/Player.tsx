import { Paper, Portal, Transition } from '@mantine/core';
import { EdgeAudio } from '~/components/EdgeMedia/EdgeAudio';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { usePlayerStore } from '~/store/player.store';

export function UniversalPlayer() {
  const { currentTrack } = usePlayerStore();

  if (!currentTrack) return null;

  return (
    <Transition mounted={!!currentTrack} duration={300} transition="slide-up">
      {(style) => (
        <Portal target="main">
          <Paper style={style}>
            {currentTrack?.media && (
              <EdgeAudio media={currentTrack.media} peaks={currentTrack.peaks} />
            )}
          </Paper>
        </Portal>
      )}
    </Transition>
  );
}
