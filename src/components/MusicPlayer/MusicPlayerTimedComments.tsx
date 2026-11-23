import clsx from 'clsx';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { Popover } from '~/components/MantineOverlays';
import type { TimedCommentCluster } from '~/components/Music/TimedComments/timed-comments';
import {
  activeTimedComment,
  clusterTimedComments,
} from '~/components/Music/TimedComments/timed-comments';
import type { MusicAccent } from '~/components/MusicPlayer/music-accent';
import {
  ACCENT_FILL,
  ACCENT_TEXT,
  ACCENT_TEXT_SCHEME,
  musicAccentVars,
} from '~/components/MusicPlayer/music-accent';
import { seekMusicPlayer } from '~/components/MusicPlayer/MusicPlayerAudio';
import { MUSIC_PLAYER_FLOAT_Z_INDEX } from '~/components/MusicPlayer/MusicPlayerLayers';
import { dimmed } from '~/components/MusicPlayer/MusicPlayerParts';
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
// Pencil `ugFe7`: a stack shows up to three avatars, then a "+N" count.
const STACK_AVATARS = 3;
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

/** A value set on enter and cleared a moment after leave, unless entered again; or at once. */
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
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setValue(null);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { value, enter, leave, close };
}

/**
 * Pencil `C81HVQ` "Comment strip": the timed comments' avatars above the bar's waveform, each at its
 * time; avatars that would overlap merge into a stack with a "+N" count (`ugFe7`). When the playhead
 * reaches one its text floats above the bar as one label (`fii8A`), and a reached stack shows its
 * comments one after another; hovering or focusing an avatar shows its label too. Hovering or
 * focusing a stack lists its comments (`iPQmn`). Arrow keys move from an avatar into its label and
 * from a stack into its list, Escape closes them. Clicking an avatar or a stack seeks to it (a stack
 * to its first comment); clicking the label or a listed comment opens the song's detail view with
 * that comment highlighted.
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
  const [layout, setLayout] = useState({ width: 0, lift: 0 });
  const stripRef = useResizeObserver<HTMLDivElement>((entry) => {
    const strip = entry.target as HTMLElement;
    const bar = strip.closest('[data-music-player-bar]') ?? strip;
    setLayout({
      width: entry.contentRect.width,
      // From the strip's top to the bar's, plus the gap: what floats clears the bar.
      lift: strip.getBoundingClientRect().top - bar.getBoundingClientRect().top + FLOAT_GAP_PX,
    });
  });
  const clusters = useMemo(
    () => clusterTimedComments(comments, duration, layout.width, AVATAR_TARGET_PX),
    [comments, duration, layout.width]
  );
  const hovered = useHoverIntent<number>();
  // By its first comment: the clusters are rebuilt when the waveform's width changes.
  const list = useHoverIntent<number>();
  const listCluster = clusters.find((cluster) => cluster.comments[0].id === list.value);
  // Set by an Arrow key on an avatar or stack: its label or list takes focus once it shows.
  const [focusFloat, setFocusFloat] = useState(false);
  const clearFocusFloat = useCallback(() => setFocusFloat(false), []);
  // Focus handed back to an avatar or stack on Escape must not open what floats from it again.
  const refocusing = useRef(false);

  const label = listCluster
    ? undefined
    : comments.find((comment) => comment.id === hovered.value) ??
      activeTimedComment(clusters, currentTime);
  // What floats is portalled out of the bar, so it takes the accent along; times in the list read
  // at 4.5:1 on its surface in each scheme.
  const accentVars = musicAccentVars(accent, 'commentList') as CSSProperties;

  const refocus = (selector: string) => {
    refocusing.current = true;
    stripRef.current?.querySelector<HTMLElement>(selector)?.focus();
    refocusing.current = false;
  };
  const closeList = (firstId: number) => {
    list.close();
    refocus(`[data-timed-cluster="${firstId}"]`);
  };
  const intoFloat = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
    event.preventDefault();
    setFocusFloat(true);
    return true;
  };

  return (
    // Over the top of the waveform: the avatars take no height of their own (S16).
    <div
      ref={stripRef}
      data-testid="timed-comment-strip"
      className="pointer-events-none absolute inset-x-0 -top-3 z-10 h-6 [&_button]:pointer-events-auto"
    >
      {/* Not before the strip is measured: a mounted Popover keeps the offset it began with. */}
      {layout.lift > 0 &&
        clusters.map((cluster) => {
          const [first] = cluster.comments;
          const isList = cluster === listCluster;
          const labelHere = label && cluster.comments.includes(label) ? label : undefined;
          // The same hold on the stack and on its list: moving between them keeps the list open.
          const hold = {
            onPointerEnter: () => list.enter(first.id),
            onPointerLeave: list.leave,
            onFocus: () => {
              if (!refocusing.current) list.enter(first.id);
            },
            onBlur: list.leave,
          };
          const onListKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && isList) {
              // Kept from the page's Escape (which closes the detail view): this Escape is the list's.
              event.preventDefault();
              event.stopPropagation();
              closeList(first.id);
            }
          };
          return (
            <FloatAbove
              key={first.id}
              opened={!!labelHere || isList}
              lift={layout.lift}
              style={accentVars}
              target={
                cluster.comments.length === 1 ? (
                  <button
                    type="button"
                    aria-label={commentName(first)}
                    data-timed-comment={first.id}
                    onClick={() => seekMusicPlayer(first.timestampSec)}
                    onPointerEnter={() => hovered.enter(first.id)}
                    onPointerLeave={hovered.leave}
                    onFocus={() => {
                      if (!refocusing.current) hovered.enter(first.id);
                    }}
                    onBlur={hovered.leave}
                    onKeyDown={(event) => {
                      if (intoFloat(event)) hovered.enter(first.id);
                      else if (event.key === 'Escape' && hovered.value === first.id) {
                        event.preventDefault();
                        event.stopPropagation();
                        hovered.close();
                      }
                    }}
                    className="group/avatar absolute top-0 flex size-6 -translate-x-1/2 items-center justify-center rounded-full hover:z-10"
                    style={{ left: `${share(first.timestampSec, duration) * 100}%` }}
                  >
                    <StripAvatar comment={first} className="group-hover/avatar:scale-110" />
                  </button>
                ) : (
                  <StackButton
                    cluster={cluster}
                    left={share(cluster.timestampSec, duration)}
                    expanded={isList}
                    onClick={() => seekMusicPlayer(cluster.timestampSec)}
                    onKeyDown={(event) => {
                      if (intoFloat(event)) list.enter(first.id);
                      else onListKey(event);
                    }}
                    {...hold}
                  />
                )
              }
            >
              {isList ? (
                <ClusterList
                  cluster={cluster}
                  focusFirst={focusFloat}
                  onFocused={clearFocusFloat}
                  onOpen={(comment) => openTimedComment(songId, comment.id)}
                  onKeyDown={onListKey}
                  {...hold}
                />
              ) : (
                labelHere && (
                  <TimedCommentLabel
                    comment={labelHere}
                    focusSelf={focusFloat}
                    onFocused={clearFocusFloat}
                    onClick={() => openTimedComment(songId, labelHere.id)}
                    onPointerEnter={() => hovered.value && hovered.enter(labelHere.id)}
                    onPointerLeave={hovered.leave}
                    onFocus={() => hovered.enter(labelHere.id)}
                    onBlur={hovered.leave}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return;
                      event.preventDefault();
                      event.stopPropagation();
                      hovered.close();
                      refocus(`[data-timed-comment="${labelHere.id}"]`);
                    }}
                  />
                )
              )}
            </FloatAbove>
          );
        })}
    </div>
  );
}

/**
 * A Mantine Popover above `target`, outside the bar: portalled past the bar's clipping, `lift` px
 * above the target so it clears the bar, its left edge on the target's (where the label's avatar and
 * the stack's first one line up), shifted to stay inside the window.
 */
function FloatAbove({
  opened,
  lift,
  style,
  target,
  children,
}: {
  opened: boolean;
  lift: number;
  style?: CSSProperties;
  target: ReactNode;
  children: ReactNode;
}) {
  return (
    <Popover
      opened={opened}
      position="top-start"
      offset={lift}
      withinPortal
      unstyled
      zIndex={MUSIC_PLAYER_FLOAT_Z_INDEX}
      // The list names its own role, and the stack its popup.
      withRoles={false}
      closeOnEscape={false}
      middlewares={{ flip: false, shift: { padding: FLOAT_EDGE_PX } }}
    >
      <Popover.Target>{target}</Popover.Target>
      {/* `unstyled` drops the dropdown's own positioning along with its surface. */}
      <Popover.Dropdown className="absolute" style={style}>
        {children}
      </Popover.Dropdown>
    </Popover>
  );
}

type StackButtonProps = {
  cluster: Cluster;
  left: number;
  expanded: boolean;
} & Pick<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onClick' | 'onKeyDown' | 'onPointerEnter' | 'onPointerLeave' | 'onFocus' | 'onBlur' | 'className'
>;

// A ref, for the Popover it anchors.
const StackButton = forwardRef<HTMLButtonElement, StackButtonProps>(function StackButton(
  { cluster, left, expanded, className, ...props },
  ref
) {
  const shown = cluster.comments.slice(0, STACK_AVATARS);
  const more = cluster.comments.length - shown.length;
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      aria-label={`${cluster.comments.length} comments around ${formatPlaybackTime(
        cluster.timestampSec
      )}`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      data-timed-cluster={cluster.comments[0].id}
      // Its first avatar centred on the first comment's time, the rest stacked after it.
      // The Popover's target clone passes a className of its own.
      className={clsx(
        'absolute top-0 flex h-6 items-center rounded-full p-0.5 hover:z-10',
        className
      )}
      style={{ left: `calc(${left * 100}% - ${AVATAR_TARGET_PX / 2}px)` }}
    >
      {shown.map((comment, i) => (
        // Pencil `ugFe7`: 20px avatars 12px apart.
        <StripAvatar key={comment.id} comment={comment} className={clsx(i > 0 && '-ml-2')} />
      ))}
      {more > 0 && (
        <span className="ml-1 flex h-5 items-center rounded-[10px] bg-dark-5 px-[7px] text-[11px] font-semibold text-white">
          +{more}
        </span>
      )}
    </button>
  );
});

function StripAvatar({ comment, className }: { comment: PlayerTimedComment; className?: string }) {
  return (
    <span
      className={clsx(
        'flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-gray-0 bg-gray-2 transition-transform dark:border-dark-6 dark:bg-dark-4',
        className
      )}
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

/** Pencil `fii8A` "Active comment" with `oiINd`'s type: the name, then the comment, dimmed. */
function TimedCommentLabel({
  comment,
  focusSelf,
  onFocused,
  ...handlers
}: {
  comment: PlayerTimedComment;
  focusSelf: boolean;
  onFocused: () => void;
  onClick: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusSelf) return;
    ref.current?.focus();
    onFocused();
  }, [focusSelf, onFocused]);
  return (
    <button
      ref={ref}
      type="button"
      data-testid="timed-comment-label"
      aria-live="polite"
      aria-label={`Open ${commentName(comment)}`}
      {...handlers}
      className="flex h-6 max-w-[280px] items-center gap-1.5 rounded-xl border bg-[#0B0B0D] py-0 pl-[3px] pr-2.5 text-xs"
      style={{ borderColor: ACCENT_FILL }}
    >
      <span className="flex size-[18px] shrink-0 items-center justify-center overflow-hidden rounded-full">
        <UserAvatar
          user={comment.user}
          avatarSize={18}
          withHoverCard={false}
          withDecorations={false}
        />
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 font-semibold text-white">{comment.user.username}</span>
        <span className="min-w-0 truncate text-[#8c8fa3]">{comment.text}</span>
      </span>
    </button>
  );
}

/** Pencil `iPQmn` "Cluster popover": a stack's comments, each opening the song at it. */
function ClusterList({
  cluster,
  focusFirst,
  onFocused,
  onOpen,
  ...handlers
}: {
  cluster: Cluster;
  focusFirst: boolean;
  onFocused: () => void;
  onOpen: (comment: PlayerTimedComment) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusFirst) return;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    onFocused();
  }, [focusFirst, onFocused]);

  const moveFocus = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  const title = `Comments around ${formatPlaybackTime(cluster.timestampSec)}`;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={title}
      {...handlers}
      onKeyDown={(event) => {
        handlers.onKeyDown(event);
        moveFocus(event);
      }}
      className={clsx(
        'flex max-h-[22rem] w-80 flex-col gap-3 overflow-y-auto rounded-[14px] border border-gray-3 bg-white p-3.5 shadow-[0_12px_32px_#00000099] dark:border-dark-3 dark:bg-dark-5',
        ACCENT_TEXT_SCHEME
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-base font-bold text-black dark:text-white">{title}</span>
        <span className={clsx('shrink-0 text-xs', dimmed)}>{cluster.comments.length} total</span>
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
              <span className="shrink-0 text-xs font-medium" style={{ color: ACCENT_TEXT }}>
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
