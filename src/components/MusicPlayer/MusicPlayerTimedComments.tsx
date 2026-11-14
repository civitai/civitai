import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import { activeTimedComment } from '~/components/Music/TimedComments/timed-comments';
import { seekMusicPlayer } from '~/components/MusicPlayer/MusicPlayerAudio';
import { ACCENT } from '~/components/MusicPlayer/MusicPlayerParts';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useMusicPlayerStore } from '~/store/music-player.store';
import type { RouterOutput } from '~/types/router';
import { formatPlaybackTime } from '~/utils/audio-player';
import { trpc } from '~/utils/trpc';

export type PlayerTimedComment = RouterOutput['commentv3']['getTimed'][number];

const NONE: PlayerTimedComment[] = [];
// Past this share of the strip a label opens leftwards from its avatar, so it stays on the strip.
const LABEL_FLIP_AT = 0.6;

/** The current song's timed comments, while the listener shows them on the waveform. */
export function usePlayerTimedComments(songId: number) {
  const show = useMusicPlayerStore((s) => s.showTimedComments);
  const { data } = trpc.commentv3.getTimed.useQuery({ imageId: songId }, { enabled: show });
  return show ? data ?? NONE : NONE;
}

const share = (timestampSec: number, duration: number) =>
  duration > 0 ? Math.min(1, Math.max(0, timestampSec / duration)) : 0;

/**
 * Pencil `C81HVQ` "Comment strip": the timed comments' avatars above the bar's waveform, each at its
 * time. When the playhead reaches one, its text opens as one label at the avatar (`fii8A`), replaced
 * by the next and gone after a few seconds; hovering an avatar opens its label too. Clicking an
 * avatar seeks there.
 */
export function TimedCommentStrip({
  comments,
  duration,
  currentTime,
}: {
  comments: PlayerTimedComment[];
  duration: number;
  currentTime: number;
}) {
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const label =
    comments.find((c) => c.id === hoveredId) ?? activeTimedComment(comments, currentTime);

  return (
    <div data-testid="timed-comment-strip" className="relative h-6 w-full shrink-0">
      {comments.map((comment) => (
        <button
          key={comment.id}
          type="button"
          aria-label={`${comment.user.username ?? 'Someone'} at ${formatPlaybackTime(
            comment.timestampSec
          )}: ${comment.text}`}
          data-timed-comment={comment.id}
          onClick={() => seekMusicPlayer(comment.timestampSec)}
          onPointerEnter={() => setHoveredId(comment.id)}
          onPointerLeave={() => setHoveredId((id) => (id === comment.id ? null : id))}
          className="absolute top-0.5 flex size-5 -translate-x-1/2 items-center justify-center overflow-hidden rounded-full border-2 border-gray-0 bg-gray-2 transition-transform hover:z-10 hover:scale-110 dark:border-dark-6 dark:bg-dark-4"
          style={{ left: `${share(comment.timestampSec, duration) * 100}%` }}
        >
          <UserAvatar
            user={comment.user}
            avatarSize={16}
            withHoverCard={false}
            withDecorations={false}
          />
        </button>
      ))}
      {label && <TimedCommentLabel comment={label} at={share(label.timestampSec, duration)} />}
    </div>
  );
}

function TimedCommentLabel({ comment, at }: { comment: PlayerTimedComment; at: number }) {
  // The label's own avatar sits over the strip's: 3px padding plus half its 18px avatar.
  const anchor: CSSProperties =
    at > LABEL_FLIP_AT
      ? { right: `calc(${(1 - at) * 100}% - 12px)` }
      : { left: `calc(${at * 100}% - 12px)` };
  return (
    <div
      data-testid="timed-comment-label"
      aria-live="polite"
      className={clsx(
        'pointer-events-none absolute top-0 z-20 flex h-6 max-w-[280px] items-center gap-1.5 rounded-xl border bg-[#0B0B0D] py-0 pl-[3px] pr-2.5 text-[11px] font-medium text-white',
        at > LABEL_FLIP_AT && 'flex-row-reverse pl-2.5 pr-[3px]'
      )}
      style={{ ...anchor, borderColor: ACCENT }}
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
        <span className="font-semibold">{comment.user.username}</span>
        {'  '}
        {comment.text}
      </span>
    </div>
  );
}
