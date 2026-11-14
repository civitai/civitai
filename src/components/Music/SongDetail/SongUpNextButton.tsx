import type { ButtonProps } from '@mantine/core';
import { Button, Text } from '@mantine/core';
import { IconPlaylist } from '@tabler/icons-react';
import { useState } from 'react';
import { ViewerBrowsingLevelScope } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { MusicUpNextPanel } from '~/components/MusicPlayer/MusicUpNextPanel';
import { useMusicPlayerCover } from '~/components/MusicPlayer/useMusicPlayerCover';
import type { MusicTrack } from '~/store/music-player.store';
import { useMusicPlayerStore } from '~/store/music-player.store';

/**
 * The song detail view's Up next button (Pencil `bgZ7u`): opens the global player's Up next panel.
 * Shown only while the player has a song; the queue stays the player's either way.
 */
export function SongUpNextButton({ buttonProps }: { buttonProps?: Partial<ButtonProps> }) {
  const current = useMusicPlayerStore((s) => s.current);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  if (!current) return null;
  return (
    <>
      <Button
        {...buttonProps}
        ref={setButton}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IconPlaylist size={16} color="white" />
        <Text size="xs" fw={500}>
          Up next
        </Text>
      </Button>
      {open && (
        <ViewerBrowsingLevelScope>
          <UpNext current={current} ignore={button} onClose={() => setOpen(false)} />
        </ViewerBrowsingLevelScope>
      )}
    </>
  );
}

function UpNext({
  current,
  ignore,
  onClose,
}: {
  current: MusicTrack;
  ignore: HTMLElement | null;
  onClose: () => void;
}) {
  const { accent } = useMusicPlayerCover(current.id);
  return <MusicUpNextPanel current={current} accent={accent} ignore={ignore} onClose={onClose} />;
}
