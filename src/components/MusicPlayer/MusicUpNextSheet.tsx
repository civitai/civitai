import { Drawer } from '@mantine/core';
import type { CSSProperties } from 'react';
import type { MusicAccent } from '~/components/MusicPlayer/music-accent';
import { musicSurface } from '~/components/MusicPlayer/music-accent';
import { MUSIC_UP_NEXT_SHEET_Z_INDEX } from '~/components/MusicPlayer/MusicPlayerLayers';
import { MusicUpNextList } from '~/components/MusicPlayer/MusicUpNextPanel';
import { useSwipeToClose } from '~/components/MusicPlayer/useSwipeToClose';
import { useHistoryLayer } from '~/hooks/useHistoryLayer';
import type { MusicTrack } from '~/store/music-player.store';

/**
 * Up next on a phone (Pencil `sQ6E2`): the desktop panel's list in a bottom sheet, over the
 * now-playing sheet, dark in both schemes as that sheet is. Closes by Escape (unless a row is being
 * dragged), a downward drag of its top, Back and the scrim.
 */
export function MusicUpNextSheet({
  current,
  accent,
  opened,
  onClose,
}: {
  current: MusicTrack;
  accent: MusicAccent | null;
  opened: boolean;
  onClose: () => void;
}) {
  useHistoryLayer(opened, onClose);
  const { offset, handlers: swipe } = useSwipeToClose(onClose);
  const surface = musicSurface(accent, 'upNextSheet');
  return (
    <Drawer.Root
      opened={opened}
      onClose={onClose}
      position="bottom"
      size="auto"
      zIndex={MUSIC_UP_NEXT_SHEET_Z_INDEX}
      // The list's own Escape, which leaves a drag to cancel first.
      closeOnEscape={false}
      transitionProps={{ duration: 200 }}
      // Dark in both schemes, as the now-playing sheet under it is (Pencil `sQ6E2`).
      classNames={{
        content: 'flex flex-col overflow-hidden rounded-t-2xl border-t border-dark-4 bg-dark-5',
      }}
      styles={{ content: { flex: '0 0 auto', width: '100%', height: 'auto', maxHeight: '85dvh' } }}
    >
      <Drawer.Overlay backgroundOpacity={0.65} />
      <Drawer.Content
        aria-label="Up next"
        className={surface.className}
        style={
          {
            ...surface.style,
            transform: offset ? `translateY(${offset}px)` : undefined,
          } as CSSProperties
        }
      >
        {/* The list's own `dark:` styles, whatever the page's scheme. */}
        <Drawer.Body
          data-mantine-color-scheme="dark"
          className="flex min-h-0 flex-1 flex-col p-0 pb-[var(--safe-area-inset-bottom)]"
        >
          <div
            data-testid="up-next-grab"
            className="flex shrink-0 touch-none justify-center pb-1 pt-2"
            {...swipe}
          >
            <span aria-hidden className="h-1 w-9 rounded-sm bg-dark-2" />
          </div>
          <MusicUpNextList current={current} onEscape={onClose} sheet />
        </Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
  );
}
