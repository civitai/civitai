import { Button } from '@mantine/core';
import { IconHourglass, IconPlayerPlayFilled } from '@tabler/icons-react';
import { Tooltip } from '~/components/MantineOverlays';
import type { SongTimeChoice } from '~/components/Music/TimedComments/SongCommentsContext';
import { useSongComments } from '~/components/Music/TimedComments/SongCommentsContext';
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

/** A timed comment's time in the list: plays the song from there. */
export function CommentTimeChip({ timestampSec }: { timestampSec: number }) {
  const song = useSongComments();
  if (!song) return null;
  const time = formatPlaybackTime(timestampSec);
  return (
    <Button
      type="button"
      size="compact-xs"
      // Pencil `D16w5R`: radius 4, 11px bold.
      radius="sm"
      variant="light"
      className="text-[11px] font-bold"
      leftSection={<IconPlayerPlayFilled size={9} />}
      aria-label={`Play from ${time}`}
      onClick={() => song.playFrom(timestampSec)}
    >
      {time}
    </Button>
  );
}
