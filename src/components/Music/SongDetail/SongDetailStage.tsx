import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import type { CSSProperties } from 'react';
import { ViewerBrowsingLevelScope } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { Tooltip } from '~/components/MantineOverlays';
import { SongLyrics } from '~/components/Music/SongDetail/SongLyrics';
import { useMoreFromCreator } from '~/components/Music/SongDetail/useMoreFromCreator';
import { accentAt, Equalizer, SongArt } from '~/components/MusicPlayer/MusicPlayerParts';
import type { SongImage } from '~/components/MusicPlayer/PostSong';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import { useMusicPlayerCover } from '~/components/MusicPlayer/useMusicPlayerCover';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import { formatPlaybackTime } from '~/utils/audio-player';
import { trpc } from '~/utils/trpc';

const store = useMusicPlayerStore.getState;

// Pencil `VKZHS` scaled up for the instrumental stage (variant c).
const BIG_EQ_HEIGHTS = [48, 80, 36, 64, 96, 52, 72, 40];

/** True when the detail view shows `image` as a song: an audio image, with the `music` flag on. */
export function isSongDetail(image: { type: string }, features: { music?: boolean }) {
  return !!features.music && image.type === 'audio';
}

/**
 * A song in the image detail view (Pencil `03 Song detail` `bgZ7u`, phone `dVjl0`): the cover with a
 * play button, title and creator, and the lyrics beside it, or an instrumental card when it has none.
 * It plays through the global player with the creator's other songs as Up next, and opening it never
 * starts playback. `revealed` is the image guard's verdict: until then neither cover nor lyrics show,
 * and it cannot be played from here.
 */
export function SongDetailStage(props: { image: SongImage; revealed: boolean }) {
  // The viewer's level, not the detail page's: the page scopes its tree to the song's own rating.
  return (
    <ViewerBrowsingLevelScope>
      <SongDetailStageContent {...props} />
    </ViewerBrowsingLevelScope>
  );
}

function SongDetailStageContent({ image, revealed }: { image: SongImage; revealed: boolean }) {
  const track = songTrack(image);
  const title = track.title || 'Untitled song';
  const { cover, accent } = useMusicPlayerCover(image.id);
  const moreFrom = useMoreFromCreator(image, { enabled: revealed });
  const {
    data: lyrics,
    isLoading: lyricsLoading,
    isError: lyricsFailed,
  } = trpc.image.getSongLyrics.useQuery({ id: image.id }, { enabled: revealed });
  const isCurrent = useMusicPlayerStore((s) => s.current?.id === image.id);
  const playing = useMusicPlayerStore((s) => s.current?.id === image.id && s.playing);

  // Up next reads "Next from <name>", so the list is named by the creator alone.
  const play = (startAtSec?: number) =>
    store().playFromList({
      name: image.user.username || moreFrom.name,
      tracks: [image, ...moreFrom.songs].map(songTrack),
      index: 0,
      startAtSec,
    });
  const togglePlay = () => (isCurrent ? store().togglePlay() : play());
  const lyricsState = !revealed
    ? 'hidden'
    : lyricsLoading
    ? 'loading'
    : lyricsFailed
    ? 'failed'
    : lyrics?.length
    ? 'lyrics'
    : 'none';

  return (
    <div
      data-lyrics-scroll
      data-testid="song-detail-stage"
      className="flex size-full flex-col gap-6 overflow-y-auto px-4 pb-6 pt-1 text-white @md:flex-row @md:items-center @md:gap-10 @md:overflow-hidden @md:px-16 @md:py-10"
      style={
        (accent
          ? { '--music-accent': accent.accent, '--music-accent-2': accent.accent2 }
          : undefined) as CSSProperties
      }
    >
      <div className="flex w-full shrink-0 flex-col gap-3.5 @md:w-80 @md:gap-[18px]">
        <div
          className="relative h-[300px] w-full shrink-0 rounded-2xl @md:size-80 @md:rounded-3xl"
          style={{ boxShadow: `0 20px 60px ${accentAt(40)}` }}
        >
          <SongArt
            url={revealed ? cover?.url : undefined}
            width={320}
            iconSize={72}
            className="size-full rounded-2xl @md:rounded-3xl"
          />
          {isCurrent && (
            <span className="absolute bottom-3.5 left-3.5 flex items-center gap-2 rounded-[18px] bg-[#141517CC] px-3 py-[7px] text-xs font-semibold">
              <Equalizer playing={playing} />
              {playing ? <PlayingTime /> : 'Paused'}
            </span>
          )}
          {revealed && (
            <Tooltip label={playing ? 'Pause' : 'Play'}>
              <button
                type="button"
                aria-label={`${playing ? 'Pause' : 'Play'} ${title}`}
                onClick={togglePlay}
                className="absolute bottom-3.5 right-3.5 flex size-16 items-center justify-center rounded-full bg-white text-dark-7 shadow-[0_8px_24px_#00000066] transition-transform hover:scale-105 @md:bottom-[22px] @md:right-[22px] @md:size-[72px]"
              >
                {playing ? (
                  <IconPlayerPauseFilled className="size-[26px] @md:size-[30px]" />
                ) : (
                  <IconPlayerPlayFilled className="size-[26px] @md:size-[30px]" />
                )}
              </button>
            </Tooltip>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-[28px] font-extrabold leading-tight @md:text-[34px] @md:font-bold">
            {title}
          </h1>
          <span className="text-[13px] text-white/70">
            {[track.creator.username, formatPlaybackTime(track.durationSec)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      </div>
      <div
        data-lyrics-scroll
        className="min-w-0 flex-1 @md:max-h-full @md:self-stretch @md:overflow-y-auto @md:py-[10%] @md:[mask-image:linear-gradient(to_bottom,transparent,black_8%,black_92%,transparent)]"
      >
        <div className="@md:flex @md:min-h-full @md:flex-col @md:justify-center">
          {lyricsState === 'loading' && <LyricsPlaceholder />}
          {lyricsState === 'failed' && (
            <p className="m-0 text-sm text-white/70">Lyrics couldn&apos;t load.</p>
          )}
          {lyricsState === 'lyrics' && lyrics && (
            <SongLyrics songId={image.id} lines={lyrics} play={play} />
          )}
          {lyricsState === 'none' && <Instrumental playing={playing} />}
        </div>
      </div>
    </div>
  );
}

// Line widths for the loading bars, so they read as lines of text.
const PLACEHOLDER_WIDTHS = ['72%', '88%', '64%', '80%', '56%'];

function LyricsPlaceholder() {
  return (
    <div aria-label="Loading lyrics" role="status" className="flex flex-col gap-4">
      {PLACEHOLDER_WIDTHS.map((width) => (
        <span
          key={width}
          className="h-6 animate-pulse rounded-md bg-white/10 @md:h-[46px]"
          style={{ width }}
        />
      ))}
    </div>
  );
}

function PlayingTime() {
  const currentTime = useMusicPlayheadStore((s) => s.currentTime);
  return <>Playing {formatPlaybackTime(currentTime)}</>;
}

/** Pencil `bgZ7u` variant c: a song with no lyrics. */
function Instrumental({ playing }: { playing: boolean }) {
  return (
    <div className="flex flex-col gap-4 @md:h-full @md:justify-center">
      <span className="text-[13px] font-bold tracking-wide text-white/55">INSTRUMENTAL</span>
      <span className="text-[28px] font-bold leading-tight @md:text-[44px]">
        No lyrics on this one.
      </span>
      <span aria-hidden className="flex h-24 items-end gap-2">
        {BIG_EQ_HEIGHTS.map((height, i) => (
          <span
            key={i}
            className="w-6 rounded-sm transition-[height] duration-300"
            style={{
              height: playing ? height : height / 2,
              backgroundColor: playing
                ? 'var(--music-accent, var(--mantine-primary-color-filled))'
                : accentAt(50),
            }}
          />
        ))}
      </span>
    </div>
  );
}
