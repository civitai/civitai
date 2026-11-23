import { Drawer } from '@mantine/core';
import {
  IconChevronDown,
  IconHeart,
  IconHeartFilled,
  IconMessage,
  IconPlaylist,
  IconWand,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { useMemo, useState } from 'react';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { isRemixMenuVisible, RemixMenu } from '~/components/Image/Remix/RemixMenu';
import {
  currentLyricIndex,
  isSyncedLyrics,
  toLyricRows,
} from '~/components/Music/SongDetail/song-lyrics';
import { NextLink } from '~/components/NextLink/NextLink';
import type { MusicAccent } from '~/components/MusicPlayer/music-accent';
import {
  ACCENT_FILL,
  ACCENT_TEXT,
  ACCENT_TEXT_SCHEME,
  musicAccentVars,
  withAlpha,
} from '~/components/MusicPlayer/music-accent';
import {
  MUSIC_SHEET_Z_INDEX,
  MUSIC_UP_NEXT_SHEET_Z_INDEX,
} from '~/components/MusicPlayer/MusicPlayerLayers';
import { SongArt, songCreatorHref } from '~/components/MusicPlayer/MusicPlayerParts';
import { Timeline, Transport } from '~/components/MusicPlayer/MusicPlayerTransport';
import { MusicUpNextSheet } from '~/components/MusicPlayer/MusicUpNextSheet';
import { ReactionButton } from '~/components/Reaction/ReactionButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHistoryLayer } from '~/hooks/useHistoryLayer';
import { useSwipeToClose } from '~/components/MusicPlayer/useSwipeToClose';
import type { MusicTrack } from '~/store/music-player.store';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import { trpc } from '~/utils/trpc';

const store = useMusicPlayerStore.getState;

const headerButton =
  'flex size-9 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/10';
const pill =
  'flex h-[38px] min-w-0 flex-1 items-center justify-center gap-2 rounded-[22px] px-3 text-[13px] text-white';

/**
 * The phone's now-playing sheet (Pencil `KUEww`): the bar's song full height, with the cover, the
 * lyric lines around the playhead, the waveform with its timed comments (on a phone they show only
 * here), the transport, and the comments, Up next and Remix actions. The same store, transport,
 * timeline and accent as the desktop bar. Closes by its chevron, a downward drag of its top,
 * Escape and Back; closing the player is in its header, as the mini bar has no room for it.
 */
export function MusicNowPlayingSheet({
  track,
  accent,
  coverUrl,
  opened,
  onClose,
}: {
  track: MusicTrack;
  accent: MusicAccent | null;
  coverUrl?: string;
  opened: boolean;
  onClose: () => void;
}) {
  const playing = useMusicPlayerStore((s) => s.playing);
  const listName = useMusicPlayerStore((s) => s.listName);
  const [upNextOpen, setUpNextOpen] = useState(false);
  const { offset: dragY, handlers: swipe } = useSwipeToClose(onClose);
  // Slid in: a timed comment's label is placed once, when it opens, so not while the sheet moves.
  const [settled, setSettled] = useState(false);
  // Back closes the latest layer first: the Up next sheet when it is open.
  useHistoryLayer(opened, onClose);

  return (
    <>
      <Drawer.Root
        opened={opened}
        onClose={onClose}
        position="bottom"
        size="100%"
        zIndex={MUSIC_SHEET_Z_INDEX}
        // Escape closes the Up next sheet over it first.
        closeOnEscape={!upNextOpen}
        transitionProps={{
          duration: 200,
          onEntered: () => setSettled(true),
          onExit: () => setSettled(false),
        }}
        classNames={{ content: 'overflow-hidden text-white' }}
        styles={{ content: { backgroundColor: 'var(--mantine-color-dark-7)' } }}
      >
        <Drawer.Content
          aria-label="Now playing"
          className={ACCENT_TEXT_SCHEME}
          style={
            {
              ...musicAccentVars(accent, 'nowPlayingSheet'),
              transform: dragY ? `translateY(${dragY}px)` : undefined,
            } as CSSProperties
          }
        >
          <Drawer.Body className="relative h-full p-0">
            {/* Pencil `CdeK2` + `QvBhr`: the cover's colours, darkened toward the controls. */}
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background: accent
                  ? `linear-gradient(180deg, ${withAlpha(accent.accent2, 0.8)} 0%, ${withAlpha(
                      accent.accent,
                      0.4
                    )} 45%, transparent 100%)`
                  : undefined,
              }}
            />
            <div
              aria-hidden
              className="absolute inset-0 bg-gradient-to-b from-transparent via-dark-7/60 to-dark-7"
            />
            <div className="relative flex h-full flex-col gap-5 overflow-y-auto px-6 pb-[calc(24px+var(--safe-area-inset-bottom))] pt-2">
              <div
                data-testid="now-playing-grab"
                className="flex shrink-0 touch-none flex-col items-center gap-2"
                {...swipe}
              >
                <span aria-hidden className="h-1 w-9 rounded-sm bg-white/40" />
                <div className="flex w-full items-center gap-3">
                  <button
                    type="button"
                    aria-label="Collapse"
                    onClick={onClose}
                    className={headerButton}
                  >
                    <IconChevronDown size={24} />
                  </button>
                  <span className="min-w-0 flex-1 truncate text-center text-[13px] font-medium text-white/80">
                    {listName ? `Playing from ${listName}` : 'Now playing'}
                  </span>
                  <button
                    type="button"
                    aria-label="Close player"
                    onClick={() => store().close()}
                    className={headerButton}
                  >
                    <IconX size={22} />
                  </button>
                </div>
              </div>
              {/* The spare height goes to the cover, up to the content's width, and what is left is
                  split above and below it rather than pooled under it. */}
              <div className="flex min-h-[120px] flex-1 items-center justify-center">
                <SongArt
                  url={coverUrl}
                  width={342}
                  iconSize={72}
                  className="aspect-square h-full max-h-[342px] rounded-[22px] shadow-[0_20px_60px_#00000066]"
                />
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <h2 className="m-0 truncate text-[26px] font-bold leading-tight">
                    {track.title || 'Untitled song'}
                  </h2>
                  <NextLink
                    href={songCreatorHref(track.creator.username)}
                    onClick={onClose}
                    className="truncate text-sm text-white/80 hover:underline"
                  >
                    {track.creator.username}
                  </NextLink>
                </div>
                <SongActions track={track} part="like" onLeave={onClose} />
              </div>
              <NowPlayingLyrics songId={track.id} />
              <div className="shrink-0">
                <Timeline
                  track={track}
                  playing={playing}
                  accent={accent}
                  sheet
                  timedComments={settled && !dragY}
                />
              </div>
              <Transport playing={playing} sheet />
              <div className="flex shrink-0 gap-2.5">
                <SongActions track={track} part="comments" onLeave={onClose} />
                <button
                  type="button"
                  aria-label="Up next"
                  aria-expanded={upNextOpen}
                  onClick={() => setUpNextOpen(true)}
                  className={clsx(pill, 'bg-white/10 font-semibold')}
                >
                  <IconPlaylist size={16} />
                  Up next
                </button>
                <SongActions track={track} part="remix" onLeave={onClose} />
              </div>
            </div>
          </Drawer.Body>
        </Drawer.Content>
      </Drawer.Root>
      <MusicUpNextSheet
        current={track}
        accent={accent}
        opened={opened && upNextOpen}
        onClose={() => setUpNextOpen(false)}
      />
    </>
  );
}

/**
 * The parts of the sheet that need the song's image row: the like, the comment count and Remix.
 * The same read as the song's detail view, so opening one after the other reads it once.
 * `onLeave` collapses the sheet for what opens elsewhere (the detail view, the generator).
 */
function SongActions({
  track,
  part,
  onLeave,
}: {
  track: MusicTrack;
  part: 'like' | 'comments' | 'remix';
  onLeave: () => void;
}) {
  const currentUser = useCurrentUser();
  const { data: image } = trpc.image.get.useQuery({ id: track.id });

  if (part === 'comments') {
    const count = image?.stats?.commentCountAllTime;
    return (
      <RoutedDialogLink
        name="imageDetail"
        state={{ imageId: track.id }}
        onClick={onLeave}
        className={clsx(pill, 'bg-white/10 font-semibold hover:no-underline')}
      >
        <IconMessage size={16} />
        <span className="truncate">
          {count === undefined ? 'Comments' : `${count} ${count === 1 ? 'comment' : 'comments'}`}
        </span>
      </RoutedDialogLink>
    );
  }

  if (part === 'remix') {
    // A row whose media the viewer may not see has no url, and nothing to remix.
    if (!image || image.url === null || !isRemixMenuVisible(image)) return null;
    return (
      <RemixMenu
        image={image}
        source="remix:music-player"
        zIndex={MUSIC_UP_NEXT_SHEET_Z_INDEX}
        onAction={onLeave}
      >
        <button type="button" className={clsx(pill, 'bg-blue-6 font-bold')}>
          <IconWand size={16} />
          Remix this
        </button>
      </RemixMenu>
    );
  }

  if (!image) return <span className="size-9 shrink-0" />;
  return (
    <ReactionButton
      entityType="image"
      entityId={track.id}
      reaction="Heart"
      userReaction={image.reactions?.find(
        (r) => r.userId === currentUser?.id && r.reaction === 'Heart'
      )}
      readonly={!currentUser || currentUser.muted}
    >
      {({ hasReacted, canClick }) => (
        <button
          type="button"
          aria-label={hasReacted ? 'Unlike' : 'Like'}
          aria-pressed={hasReacted}
          disabled={!canClick}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-60"
          style={hasReacted ? { color: ACCENT_TEXT } : undefined}
        >
          {hasReacted ? <IconHeartFilled size={24} /> : <IconHeart size={24} />}
        </button>
      )}
    </ReactionButton>
  );
}

/**
 * Pencil `Xl6oW`: the line before the playhead, the line at it (set apart by size, weight, full
 * white and the accent marker) and the next one. Only for lyrics with times; before the first
 * line, the first lines show as coming up.
 */
function NowPlayingLyrics({ songId }: { songId: number }) {
  const { data: lines } = trpc.image.getSongLyrics.useQuery({ id: songId });
  const synced = useMemo(() => !!lines && isSyncedLyrics(lines), [lines]);
  const sung = useMemo(
    () =>
      lines
        ? toLyricRows(lines).flatMap((row) => (row.kind === 'line' && row.t != null ? [row] : []))
        : [],
    [lines]
  );
  const currentIndex = useMusicPlayheadStore((s) =>
    synced && lines ? currentLyricIndex(lines, s.currentTime * 1000) : -1
  );
  if (!synced || !sung.length) return null;

  const at = sung.findIndex((row) => row.index === currentIndex);
  const [past, current, next] =
    at < 0 ? [null, sung[0], sung[1]] : [sung[at - 1], sung[at], sung[at + 1]];
  const reached = at >= 0;

  return (
    <div data-testid="now-playing-lyrics" className="flex shrink-0 flex-col gap-2.5">
      {past && (
        <p className="m-0 line-clamp-2 text-xl font-semibold leading-tight text-white/45">
          {past.text}
        </p>
      )}
      {current && (
        <div className="flex gap-3">
          {reached && (
            <span
              aria-hidden
              className="w-1 shrink-0 self-stretch rounded-sm"
              style={{ backgroundColor: ACCENT_FILL }}
            />
          )}
          <p
            aria-current={reached || undefined}
            className={clsx(
              'm-0 line-clamp-2 leading-tight',
              reached ? 'text-[30px] font-bold text-white' : 'text-xl font-semibold text-white/70'
            )}
          >
            {current.text}
          </p>
        </div>
      )}
      {next && (
        <p className="m-0 line-clamp-1 text-xl font-semibold leading-tight text-white/70">
          {next.text}
        </p>
      )}
    </div>
  );
}
