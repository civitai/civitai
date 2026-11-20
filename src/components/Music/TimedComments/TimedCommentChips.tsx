import { Button, useMantineTheme } from '@mantine/core';
import { IconHourglass, IconPlayerPlayFilled } from '@tabler/icons-react';
import { Tooltip } from '~/components/MantineOverlays';
import type { SongTimeChoice } from '~/components/Music/TimedComments/SongCommentsContext';
import { useSongComments } from '~/components/Music/TimedComments/SongCommentsContext';
import { ACCENT_TEXT, accentTextVars, blend } from '~/components/MusicPlayer/music-accent';
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

// The comment card (Mantine Card) in each scheme, and the chip's tint over it.
const CARD = { light: '#ffffff', dark: '#25262b' };
const CHIP_TINT = 0.12;
const CHIP_HOVER_TINT = CHIP_TINT * 1.6;
const CHIP_BG =
  '[--chip-bg:var(--chip-bg-light)] [--chip-hover:var(--chip-hover-light)] dark:[--chip-bg:var(--chip-bg-dark)] dark:[--chip-hover:var(--chip-hover-dark)]';

/** A timed comment's time in the list: plays the song from there. */
export function CommentTimeChip({ timestampSec }: { timestampSec: number }) {
  const song = useSongComments();
  const theme = useMantineTheme();
  if (!song) return null;
  const time = formatPlaybackTime(timestampSec);
  const primary = theme.colors[theme.primaryColor][6];
  return (
    <Button
      type="button"
      size="compact-xs"
      // Pencil `D16w5R`: radius 4, 11px bold.
      radius="sm"
      variant="light"
      className={`text-[11px] font-bold ${ACCENT_TEXT} ${CHIP_BG}`}
      // The primary darkened or lightened per scheme to 4.5:1 on the hover tint, the strongest the
      // chip shows, so it reads at rest and under the pointer.
      // The tint is pre-blended over the card so it is opaque: a highlighted comment's tint behind
      // the chip cannot lower that contrast.
      style={{
        ...accentTextVars(primary, CARD, CHIP_HOVER_TINT),
        '--chip-bg-light': blend(primary, CARD.light, CHIP_TINT),
        '--chip-bg-dark': blend(primary, CARD.dark, CHIP_TINT),
        '--chip-hover-light': blend(primary, CARD.light, CHIP_HOVER_TINT),
        '--chip-hover-dark': blend(primary, CARD.dark, CHIP_HOVER_TINT),
        '--button-bg': 'var(--chip-bg)',
        '--button-hover': 'var(--chip-hover)',
        '--button-color': 'var(--accent-text)',
      }}
      leftSection={<IconPlayerPlayFilled size={9} />}
      aria-label={`Play from ${time}`}
      onClick={() => song.playFrom(timestampSec)}
    >
      {time}
    </Button>
  );
}
