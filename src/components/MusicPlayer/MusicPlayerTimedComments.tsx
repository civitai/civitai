import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import type { TimedCommentCluster } from '~/components/Music/TimedComments/timed-comments';
import {
  activeTimedComment,
  clusterTimedComments,
} from '~/components/Music/TimedComments/timed-comments';
import type { MusicAccent } from '~/components/MusicPlayer/music-accent';
import { seekMusicPlayer } from '~/components/MusicPlayer/MusicPlayerAudio';
import { MUSIC_PLAYER_FLOAT_Z_INDEX } from '~/components/MusicPlayer/MusicPlayerLayers';
import { ACCENT } from '~/components/MusicPlayer/MusicPlayerParts';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { useMusicPlayerStore } from '~/store/music-player.store';
import type { RouterOutput } from '~/types/router';
import { formatPlaybackTime } from '~/utils/audio-player';
import { trpc } from '~/utils/trpc';

export type PlayerTimedComment = RouterOutput['commentv3']['getTimed'][number];
type Cluster = TimedCommentCluster<PlayerTimedComment>;

const NONE: PlayerTimedComment[] = [];
// The 24px target around each 20px avatar (Pencil `C81HVQ`): closer than this, avatars overlap.
const AVATAR_TARGET_PX = 24;
// Pencil `ugFe7`: a stack shows up to three avatars, 12px apart, then a "+N" count.
const STACK_AVATARS = 3;
const STACK_PITCH_PX = 12;
// How far above the bar a floating label or list sits, and how near the window's edge it may go.
const FLOAT_GAP_PX = 8;
const FLOAT_EDGE_PX = 8;
// Leaving an avatar or stack for what floats above it crosses a gap: wait before closing.
const HOVER_CLOSE_MS = 150;

/**
 * The current song's timed comments, and whether the listener shows them on the waveform. They are
 * read while hidden too, so hiding them keeps the bar's layout: the strip's row stays, empty.
 */
export function usePlayerTimedComments(songId: number) {
  const show = useMusicPlayerStore((s) => s.showTimedComments);
  const { data } = trpc.commentv3.getTimed.useQuery({ imageId: songId });
  return { comments: data ?? NONE, show };
}

const share = (timestampSec: number, duration: number) =>
  duration > 0 ? Math.min(1, Math.max(0, timestampSec / duration)) : 0;

const commentName = (comment: PlayerTimedComment) =>
  `${comment.user.username ?? 'Someone'} at ${formatPlaybackTime(comment.timestampSec)}: ${
    comment.text
  }`;

/** Opens the song's detail view with the comment highlighted, as a comment notification does. */
const openTimedComment = (songId: number, commentId: number) =>
  triggerRoutedDialog({ name: 'imageDetail', state: { imageId: songId, highlight: commentId } });

/** A value set on pointer enter and cleared a moment after pointer leave, unless entered again. */
function useHoverIntent<T>() {
  const [value, setValue] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const enter = useCallback((next: T) => {
    clearTimeout(timer.current);
    setValue(next);
  }, []);
  const leave = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setValue(null), HOVER_CLOSE_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { value, enter, leave };
}

/**
 * Pencil `C81HVQ` "Comment strip": the timed comments' avatars above the bar's waveform, each at its
 * time; avatars that would overlap merge into a stack with a "+N" count (`ugFe7`). When the playhead
 * reaches one its text floats above the bar as one label (`fii8A`), and a reached stack shows its
 * comments one after another; hovering an avatar shows its label too, hovering or focusing a stack
 * lists its comments (`iPQmn`). A click on an avatar seeks there and opens the song's detail view at
 * the comment; a click on the label or a listed comment opens it without seeking.
 */
export function TimedCommentStrip({
  songId,
  comments,
  duration,
  currentTime,
  accent,
}: {
  songId: number;
  comments: PlayerTimedComment[];
  duration: number;
  currentTime: number;
  accent: MusicAccent | null;
}) {
  const [width, setWidth] = useState(0);
  const stripRef = useResizeObserver<HTMLDivElement>((entry) => setWidth(entry.contentRect.width));
  const clusters = useMemo(
    () => clusterTimedComments(comments, duration, width, AVATAR_TARGET_PX),
    [comments, duration, width]
  );
  const hoveredComment = useHoverIntent<PlayerTimedComment>();
  // By its first comment: the clusters are rebuilt when the waveform's width changes.
  const openClusterId = useHoverIntent<number>();
  const openCluster = clusters.find((cluster) => cluster.comments[0].id === openClusterId.value);

  const label = openCluster
    ? undefined
    : hoveredComment.value ?? activeTimedComment(clusters, currentTime);
  const labelCluster = label && clusters.find((cluster) => cluster.comments.includes(label));
  const accentVars = accent
    ? ({ '--music-accent': accent.accent, '--music-accent-2': accent.accent2 } as CSSProperties)
    : undefined;

  return (
    <div ref={stripRef} data-testid="timed-comment-strip" className="relative h-6 w-full shrink-0">
      {clusters.map((cluster) => {
        const left = `${share(cluster.timestampSec, duration) * 100}%`;
        const [first] = cluster.comments;
        if (cluster.comments.length === 1)
          return (
            <button
              key={first.id}
              type="button"
              aria-label={commentName(first)}
              data-timed-comment={first.id}
              onClick={() => {
                seekMusicPlayer(first.timestampSec);
                openTimedComment(songId, first.id);
              }}
              onPointerEnter={() => hoveredComment.enter(first)}
              onPointerLeave={hoveredComment.leave}
              className="group/avatar absolute top-0 flex size-6 -translate-x-1/2 items-center justify-center rounded-full hover:z-10"
              style={{ left }}
            >
              <StripAvatar comment={first} className="group-hover/avatar:scale-110" />
            </button>
          );
        const shown = cluster.comments.slice(0, STACK_AVATARS);
        const more = cluster.comments.length - shown.length;
        return (
          <button
            key={first.id}
            type="button"
            aria-label={`${cluster.comments.length} comments around ${formatPlaybackTime(
              cluster.timestampSec
            )}`}
            aria-expanded={openCluster === cluster}
            data-timed-cluster={first.id}
            onClick={() => seekMusicPlayer(cluster.timestampSec)}
            onPointerEnter={() => openClusterId.enter(first.id)}
            onPointerLeave={openClusterId.leave}
            onFocus={() => openClusterId.enter(first.id)}
            onBlur={openClusterId.leave}
            // Its first avatar centred on the first comment's time, the rest stacked after it.
            className="absolute top-0 flex h-6 items-center rounded-full p-0.5 hover:z-10"
            style={{ left: `calc(${left} - ${AVATAR_TARGET_PX / 2}px)` }}
          >
            {shown.map((comment, i) => (
              <StripAvatar
                key={comment.id}
                comment={comment}
                className="absolute top-0.5"
                style={{ left: 2 + i * STACK_PITCH_PX }}
              />
            ))}
            <span
              aria-hidden
              className="block h-5"
              style={{ width: (shown.length - 1) * STACK_PITCH_PX + 20 }}
            />
            {more > 0 && (
              <span className="ml-1 flex h-5 items-center rounded-[10px] bg-dark-5 px-[7px] text-[11px] font-semibold text-white">
                +{more}
              </span>
            )}
          </button>
        );
      })}
      {label && labelCluster && (
        <FloatAboveBar
          strip={stripRef.current}
          at={share(labelCluster.timestampSec, duration)}
          // The label's own 18px avatar, after 3px of padding, sits over the strip's.
          anchorOffset={12}
          style={accentVars}
        >
          <TimedCommentLabel
            comment={label}
            onClick={() => openTimedComment(songId, label.id)}
            onPointerEnter={() => hoveredComment.value && hoveredComment.enter(label)}
            onPointerLeave={hoveredComment.leave}
          />
        </FloatAboveBar>
      )}
      {openCluster && (
        <FloatAboveBar
          strip={stripRef.current}
          at={share(openCluster.timestampSec, duration)}
          anchorOffset={AVATAR_TARGET_PX / 2}
          style={accentVars}
        >
          <ClusterList
            cluster={openCluster}
            onOpen={(comment) => openTimedComment(songId, comment.id)}
            onPointerEnter={() => openClusterId.enter(openCluster.comments[0].id)}
            onPointerLeave={openClusterId.leave}
            onFocus={() => openClusterId.enter(openCluster.comments[0].id)}
            onBlur={openClusterId.leave}
          />
        </FloatAboveBar>
      )}
    </div>
  );
}

function StripAvatar({
  comment,
  className,
  style,
}: {
  comment: PlayerTimedComment;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={clsx(
        'flex size-5 items-center justify-center overflow-hidden rounded-full border-2 border-gray-0 bg-gray-2 transition-transform dark:border-dark-6 dark:bg-dark-4',
        className
      )}
      style={style}
    >
      <UserAvatar
        user={comment.user}
        avatarSize={16}
        withHoverCard={false}
        withDecorations={false}
      />
    </span>
  );
}

/**
 * Floats `children` above the player bar, outside it: its left edge `anchorOffset` px before the
 * point `at` (a share of the strip's width), held inside the window. Portalled, so the bar's
 * clipping and height don't apply; the accent comes in through `style`.
 */
function FloatAboveBar({
  strip,
  at,
  anchorOffset,
  style,
  children,
}: {
  strip: HTMLElement | null;
  at: number;
  anchorOffset: number;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; bottom: number } | null>(null);

  useLayoutEffect(() => {
    const float = ref.current;
    if (!strip || !float) return;
    const measure = () => {
      const box = strip.getBoundingClientRect();
      const barTop = (strip.closest('[data-music-player-bar]') ?? strip).getBoundingClientRect()
        .top;
      const viewport = document.documentElement.clientWidth;
      const left = box.left + at * box.width - anchorOffset;
      const next = {
        left: Math.max(FLOAT_EDGE_PX, Math.min(left, viewport - FLOAT_EDGE_PX - float.offsetWidth)),
        bottom: window.innerHeight - barTop + FLOAT_GAP_PX,
      };
      setPlace((prev) =>
        prev && prev.left === next.left && prev.bottom === next.bottom ? prev : next
      );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  return createPortal(
    <div
      ref={ref}
      // Its own width, not what is left of the window at `left`: that would feed back into `left`.
      className="fixed w-max"
      style={{
        ...style,
        zIndex: MUSIC_PLAYER_FLOAT_Z_INDEX,
        left: place?.left ?? 0,
        bottom: place?.bottom ?? 0,
        visibility: place ? undefined : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body
  );
}

/** Pencil `oiINd` "Timed Comment Inline": one comment as a pill. */
function TimedCommentLabel({
  comment,
  onClick,
  onPointerEnter,
  onPointerLeave,
}: {
  comment: PlayerTimedComment;
  onClick: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="timed-comment-label"
      aria-live="polite"
      aria-label={`Open ${commentName(comment)}`}
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="flex h-6 max-w-[280px] items-center gap-1.5 rounded-xl border bg-[#0B0B0D] py-0 pl-[3px] pr-2.5 text-[11px] font-medium text-white"
      style={{ borderColor: ACCENT }}
    >
      <span className="flex size-[18px] shrink-0 items-center justify-center overflow-hidden rounded-full">
        <UserAvatar
          user={comment.user}
          avatarSize={18}
          withHoverCard={false}
          withDecorations={false}
        />
      </span>
      <span className="min-w-0 truncate">
        {comment.user.username}
        {'  '}
        {comment.text}
      </span>
    </button>
  );
}

/** Pencil `iPQmn` "Cluster popover": a stack's comments, each opening the song at it. */
function ClusterList({
  cluster,
  onOpen,
  ...handlers
}: {
  cluster: Cluster;
  onOpen: (comment: PlayerTimedComment) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const title = `Comments around ${formatPlaybackTime(cluster.timestampSec)}`;
  return (
    <div
      role="dialog"
      aria-label={title}
      {...handlers}
      className="flex max-h-80 w-80 flex-col gap-3 overflow-y-auto rounded-[14px] border border-gray-3 bg-white p-3.5 shadow-[0_12px_32px_#00000099] dark:border-dark-3 dark:bg-dark-5"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-base font-bold text-black dark:text-white">{title}</span>
        <span className="shrink-0 text-xs text-gray-6 dark:text-dark-2">
          {cluster.comments.length} total
        </span>
      </div>
      {cluster.comments.map((comment) => (
        <button
          key={comment.id}
          type="button"
          onClick={() => onOpen(comment)}
          className="flex gap-2.5 rounded-md text-left hover:bg-gray-1 dark:hover:bg-dark-4"
        >
          <span className="flex size-[26px] shrink-0 items-center justify-center overflow-hidden rounded-full">
            <UserAvatar
              user={comment.user}
              avatarSize={26}
              withHoverCard={false}
              withDecorations={false}
            />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <span className="truncate text-[13px] font-semibold text-black dark:text-white">
                {comment.user.username}
              </span>
              <span className="shrink-0 text-xs font-medium" style={{ color: ACCENT }}>
                {formatPlaybackTime(comment.timestampSec)}
              </span>
            </span>
            <span className="text-[13px] text-gray-7 dark:text-dark-0">{comment.text}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
