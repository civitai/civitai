import { Button, useMantineTheme } from '@mantine/core';
import { IconHourglass, IconPlayerPlayFilled } from '@tabler/icons-react';
import { Tooltip } from '~/components/MantineOverlays';
import type { SongTimeChoice } from '~/components/Music/TimedComments/SongCommentsContext';
import { useSongComments } from '~/components/Music/TimedComments/SongCommentsContext';
import {
  ACCENT_TEXT,
  musicSurface,
  surfaceBackground,
} from '~/components/MusicPlayer/music-accent';
import { useMusicPlayheadStore } from '~/store/music-player.store';
import { formatPlaybackTime } from '~/utils/audio-player';

/** The composer's "at m:ss" toggle on a song: the new comment sits at the playhead's time. */
export function SongTimeChip({ choice }: { choice: SongTimeChoice }) {
  const currentTime = useMusicPlayheadStore((s) => s.currentTime);
  const chip = (
    <Button
      type="button"
      size="compact-xs"
      radius="xl"
      variant={choice.on ? 'light' : 'default'}
      leftSection={<IconHourglass size={11} />}
      aria-pressed={choice.on}
      disabled={!choice.available}
      onClick={choice.toggle}
    >
      {choice.available ? `at ${formatPlaybackTime(currentTime)}` : 'at a time'}
    </Button>
  );
  if (choice.available) return chip;
  return (
    <Tooltip label="Play the song to comment at a time">
      {/* A disabled button fires no pointer events, so the tooltip hangs on its wrapper. */}
      <span className="inline-flex">{chip}</span>
    </Tooltip>
  );
}

const CHIP_BG =
  '[--chip-bg:var(--chip-bg-light)] [--chip-hover:var(--chip-hover-light)] dark:[--chip-bg:var(--chip-bg-dark)] dark:[--chip-hover:var(--chip-hover-dark)]';

/** A timed comment's time in the list: plays the song from there. */
export function CommentTimeChip({ timestampSec }: { timestampSec: number }) {
  const song = useSongComments();
  const theme = useMantineTheme();
  if (!song) return null;
  const time = formatPlaybackTime(timestampSec);
  const primary = theme.colors[theme.primaryColor][6];
  const surface = musicSurface({ accent: primary, accent2: primary }, 'commentChips');
  const tint = (scheme: 'light' | 'dark', state: 'rest' | 'hover') =>
    surfaceBackground('commentChips', scheme, state, primary);
  return (
    <Button
      type="button"
      size="compact-xs"
      // Pencil `D16w5R`: radius 4, 11px bold.
      radius="sm"
      variant="light"
      className={`text-[11px] font-bold ${surface.className} ${CHIP_BG}`}
      // The chip's tint is the primary's shade 6 in both schemes, so its text is computed from that.
      // The tint is pre-blended over the card so it is opaque: a highlighted comment's tint behind
      // the chip cannot lower that contrast.
      style={{
        ...surface.style,
        '--chip-bg-light': tint('light', 'rest'),
        '--chip-bg-dark': tint('dark', 'rest'),
        '--chip-hover-light': tint('light', 'hover'),
        '--chip-hover-dark': tint('dark', 'hover'),
        '--button-bg': 'var(--chip-bg)',
        '--button-hover': 'var(--chip-hover)',
        '--button-color': ACCENT_TEXT,
      }}
      leftSection={<IconPlayerPlayFilled size={9} />}
      aria-label={`Play from ${time}`}
      onClick={() => song.playFrom(timestampSec)}
    >
      {time}
    </Button>
  );
}
