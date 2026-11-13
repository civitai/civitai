import { useViewportSize } from '@mantine/hooks';
import {
  IconArrowsDiagonal,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { useRef, useState } from 'react';
import { Tooltip } from '~/components/MantineOverlays';
import { pixelsToPosition, positionToPixels } from '~/components/MusicPlayer/minimized-position';
import { ACCENT, accentAt, SongArt } from '~/components/MusicPlayer/MusicPlayerParts';
import { useMusicPlayerCover } from '~/components/MusicPlayer/useMusicPlayerCover';
import type { MusicTrack } from '~/store/music-player.store';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import { playbackProgress } from '~/utils/audio-player';

const SIZE = 80;
// A press that moves further than this is a drag, and presses nothing.
const DRAG_THRESHOLD_PX = 4;

const store = useMusicPlayerStore.getState;

type Pixels = { left: number; top: number };
type Drag = { x: number; y: number; origin: Pixels; moved: boolean; last: Pixels };

/**
 * The minimized player (Pencil `xtQOw`, hover `wO9tw`): a round cover with a progress ring that can
 * be dragged anywhere in the window. Hover or keyboard focus shows play/pause, expand and close;
 * on touch, the first tap shows them.
 */
export function MusicPlayerMinimized() {
  const track = useMusicPlayerStore((s) => s.current);
  const view = useMusicPlayerStore((s) => s.view);
  if (!track || view !== 'minimized') return null;
  return <Minimized track={track} />;
}

function Minimized({ track }: { track: MusicTrack }) {
  const playing = useMusicPlayerStore((s) => s.playing);
  const position = useMusicPlayerStore((s) => s.minimizedPosition);
  const { cover, accent } = useMusicPlayerCover(track.id);
  // Re-renders on resize, so a stored spot is clamped to the new window.
  const viewport = useViewportSize();
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  const [dragged, setDragged] = useState<Pixels | null>(null);
  const [revealed, setRevealed] = useState(false);

  const placed =
    dragged ?? (position && viewport.width ? positionToPixels(position, viewport, SIZE) : null);
  const placement: CSSProperties = placed
    ? { left: placed.left, top: placed.top }
    : // Default: bottom-left, clear of the footer links bar.
      { left: 16, bottom: 'calc(var(--footer-height) + 16px)' };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    swallowClick.current = false;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const origin = { left: rect.left, top: rect.top };
    drag.current = { x: e.clientX, y: e.clientY, origin, moved: false, last: origin };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
      d.moved = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // The pointer is already gone; the drag still follows the events that arrive.
      }
    }
    const bounds = { width: innerWidth, height: innerHeight };
    d.last = positionToPixels(
      pixelsToPosition({ left: d.origin.left + dx, top: d.origin.top + dy }, bounds, SIZE),
      bounds,
      SIZE
    );
    setDragged(d.last);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      swallowClick.current = true;
      store().setMinimizedPosition(
        pixelsToPosition(d.last, { width: innerWidth, height: innerHeight }, SIZE)
      );
      setDragged(null);
    } else if (e.pointerType === 'touch' && !revealed) {
      // No hover on touch: the first tap shows the controls instead of pressing one.
      swallowClick.current = true;
      setRevealed(true);
    }
  };

  const controlsShown = revealed && !dragged;

  return (
    <div
      ref={rootRef}
      data-music-player-minimized=""
      role="region"
      aria-label="Music player"
      className="group fixed z-[201] size-20 cursor-grab touch-none select-none active:cursor-grabbing"
      style={
        {
          ...(accent && { '--music-accent': accent.accent, '--music-accent-2': accent.accent2 }),
          ...placement,
        } as CSSProperties
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
        setDragged(null);
      }}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseLeave={() => setRevealed(false)}
    >
      <ProgressRing durationSec={track.durationSec} />
      <div
        className="absolute left-1.5 top-1.5 rounded-full"
        style={{ boxShadow: `0 4px 20px ${accentAt(50)}` }}
      >
        <SongArt url={cover?.url} width={68} iconSize={30} className="size-[68px] rounded-full" />
      </div>
      <div
        className={clsx(
          'transition-opacity',
          dragged
            ? 'opacity-0'
            : controlsShown
            ? 'opacity-100'
            : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
        )}
      >
        <CornerButton
          label="Expand player"
          className="-left-1 -top-1"
          onClick={() => store().expand()}
        >
          <IconArrowsDiagonal size={12} />
        </CornerButton>
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => store().togglePlay()}
          className="absolute left-1.5 top-1.5 flex size-[68px] items-center justify-center rounded-full bg-[#000000A6] text-white"
        >
          {playing ? <IconPlayerPauseFilled size={22} /> : <IconPlayerPlayFilled size={22} />}
        </button>
        <CornerButton
          label="Close player"
          className="-top-1 left-[60px]"
          onClick={() => store().close()}
        >
          <IconX size={12} />
        </CornerButton>
      </div>
    </div>
  );
}

/** Pencil `OwLvE` / `VqeIN`: the ring track and the played part in the accent. */
function ProgressRing({ durationSec }: { durationSec: number }) {
  const currentTime = useMusicPlayheadStore((s) => s.currentTime);
  const duration = useMusicPlayheadStore((s) => s.duration) || durationSec;
  const degrees = playbackProgress(currentTime, duration) * 360;
  return (
    <div
      aria-hidden
      className="absolute inset-0 rounded-full"
      style={{ background: `conic-gradient(${ACCENT} ${degrees}deg, #373A40 0deg)` }}
    />
  );
}

function CornerButton({
  label,
  className,
  onClick,
  children,
}: {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={clsx(
          'absolute z-10 flex size-6 items-center justify-center rounded-full border border-[#5C5F66] bg-[#101113] text-white',
          className
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}
