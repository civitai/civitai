import { Drawer } from '@mantine/core';
import type { CSSProperties } from 'react';
import type { MusicAccent } from '~/components/MusicPlayer/music-accent';
import { MUSIC_UP_NEXT_SHEET_Z_INDEX } from '~/components/MusicPlayer/MusicPlayerLayers';
import { MusicUpNextList } from '~/components/MusicPlayer/MusicUpNextPanel';
import { useHistoryLayer } from '~/hooks/useHistoryLayer';
import type { MusicTrack } from '~/store/music-player.store';

/**
 * Up next on a phone (Pencil `sQ6E2`): the desktop panel's list in a bottom sheet, over the
 * now-playing sheet. Closes by Escape (unless a row is being dragged), Back and the scrim.
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
      classNames={{
        content:
          'flex flex-col overflow-hidden rounded-t-2xl border-t border-gray-4 bg-white dark:border-dark-4 dark:bg-dark-5',
      }}
      styles={{ content: { flex: '0 0 auto', width: '100%', height: 'auto', maxHeight: '85dvh' } }}
    >
      <Drawer.Overlay backgroundOpacity={0.65} />
      <Drawer.Content
        aria-label="Up next"
        style={
          accent
            ? ({
                '--music-accent': accent.accent,
                '--music-accent-2': accent.accent2,
              } as CSSProperties)
            : undefined
        }
      >
        <Drawer.Body className="flex min-h-0 flex-1 flex-col p-0 pb-[var(--safe-area-inset-bottom)]">
          <span
            aria-hidden
            className="mx-auto mb-1 mt-2 h-1 w-9 shrink-0 rounded-sm bg-gray-4 dark:bg-dark-2"
          />
          <MusicUpNextList current={current} onEscape={onClose} sheet />
        </Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
  );
}
