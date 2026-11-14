import { IconMusic } from '@tabler/icons-react';
import clsx from 'clsx';
import { CollapsibleCard } from '~/components/Image/DetailV2/CollapsibleCard';
import { useMoreFromCreator } from '~/components/Music/SongDetail/useMoreFromCreator';
import { dimmed, SongArt } from '~/components/MusicPlayer/MusicPlayerParts';
import type { SongImage } from '~/components/MusicPlayer/PostSong';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import { useMusicPlayerCovers } from '~/components/MusicPlayer/useMusicPlayerCover';
import { NextLink } from '~/components/NextLink/NextLink';
import { formatPlaybackTime } from '~/utils/audio-player';
import { ViewerBrowsingLevelScope } from '~/components/BrowsingLevel/BrowsingLevelProvider';

/**
 * The song detail sidebar's "More from <creator>" card (Pencil `ThzKc`, with no remixes): the
 * creator's other songs, each opening its own detail view. The Remixes half of the design waits
 * for a read of a song's remixes; until then the card is More from only, and absent when the
 * creator has no other song.
 */
const ROW_SIZE = 3;

/** `items` in rows of at most `size`, as even as they split: 4 is 2 + 2, 5 is 3 + 2. */
function evenRows<T>(items: T[], size: number) {
  const perRow = Math.ceil(items.length / Math.ceil(items.length / size));
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  return rows;
}

function SongMoreFromCardContent({ song }: { song: SongImage }) {
  const { songs, name } = useMoreFromCreator(song);
  const covers = useMusicPlayerCovers(songs.map((s) => s.id));
  if (!songs.length) return null;
  return (
    <CollapsibleCard title={name} icon={<IconMusic />} storageKey="song-more-from">
      <div className="flex flex-col gap-2.5">
        {evenRows(songs, ROW_SIZE).map((row) => (
          <ul key={row[0].id} className="m-0 flex list-none gap-2.5 p-0">
            {row.map((other) => {
              const track = songTrack(other);
              return (
                <li key={other.id} className="min-w-0 flex-1">
                  <NextLink
                    href={`/images/${other.id}`}
                    className="flex flex-col items-center gap-1.5 rounded-lg p-1 text-center hover:bg-gray-1 dark:hover:bg-dark-5"
                  >
                    <SongArt
                      url={covers.get(other.id)?.url}
                      width={56}
                      iconSize={24}
                      className="size-14 rounded-[10px]"
                    />
                    <span className="w-full truncate text-xs font-semibold text-black dark:text-white">
                      {track.title || 'Untitled song'}
                    </span>
                    <span className={clsx('text-[11px]', dimmed)}>
                      {formatPlaybackTime(track.durationSec)}
                    </span>
                  </NextLink>
                </li>
              );
            })}
          </ul>
        ))}
      </div>
    </CollapsibleCard>
  );
}

// The viewer's level, not the detail page's: the page scopes its tree to the song's own rating.
export function SongMoreFromCard({ song }: { song: SongImage }) {
  return (
    <ViewerBrowsingLevelScope>
      <SongMoreFromCardContent song={song} />
    </ViewerBrowsingLevelScope>
  );
}
