import type {
  Announcements,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  UniqueIdentifier,
} from '@dnd-kit/core';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { Portal } from '@mantine/core';
import { useClickOutside } from '@mantine/hooks';
import {
  IconArrowsShuffle,
  IconGripVertical,
  IconRepeat,
  IconRepeatOnce,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { MusicAccent } from '~/components/MusicPlayer/music-accent';
import { MUSIC_UP_NEXT_Z_INDEX, PlayerTooltip } from '~/components/MusicPlayer/MusicPlayerLayers';
import {
  ACCENT,
  accentAt,
  dimmed,
  Equalizer,
  SongArt,
} from '~/components/MusicPlayer/MusicPlayerParts';
import { useMusicPlayerCovers } from '~/components/MusicPlayer/useMusicPlayerCover';
import type { PlayerSongCover } from '~/server/services/post.service';
import type { MusicTrack, MusicUpNextSection } from '~/store/music-player.store';
import { useMusicPlayerStore } from '~/store/music-player.store';
import { formatPlaybackTime } from '~/utils/audio-player';

const store = useMusicPlayerStore.getState;
// A drop target at the end of "Queued by you", for moving a list song below its last row.
const QUEUED_END = 'queued-end';
// Pencil `TLdXV`: the row being dragged.
const LIFTED =
  'border border-gray-4 bg-gray-1 shadow-[0_8px_20px_#000000AA] dark:border-dark-3 dark:bg-dark-5';

const brightText = 'text-black dark:text-white';

function upNextSummary(tracks: MusicTrack[]) {
  if (!tracks.length) return '0 songs';
  const seconds = tracks.reduce((sum, t) => sum + (t.durationSec || 0), 0);
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'} · ${minutes} min`;
}

type DropHint = { id: UniqueIdentifier; side: 'before' | 'after' } | null;

/**
 * Up next (Pencil `hG63C`): the playing song, then "Queued by you", then the rest of the list play
 * was pressed in. Anchored above the bar at the right; closes on Escape and on an outside click
 * (`ignore` is the button that toggles it).
 */
export function MusicUpNextPanel({
  current,
  accent,
  onClose,
  ignore,
}: {
  current: MusicTrack;
  accent: MusicAccent | null;
  onClose: () => void;
  ignore: HTMLElement | null;
}) {
  const playing = useMusicPlayerStore((s) => s.playing);
  const queued = useMusicPlayerStore((s) => s.queued);
  const list = useMusicPlayerStore((s) => s.list);
  const listName = useMusicPlayerStore((s) => s.listName);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<DropHint>(null);

  useClickOutside(onClose, null, [panel, ignore]);
  useEffect(() => {
    if (dragId !== null) return; // Escape cancels the drag first.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dragId, onClose]);

  const ids = useMemo(
    () => [...new Set([current, ...queued, ...list].map((t) => t.id))],
    [current, queued, list]
  );
  const covers = useMusicPlayerCovers(ids);
  const upNext = [...queued, ...list];
  const sectionOf = (id: UniqueIdentifier): MusicUpNextSection | null =>
    queued.some((t) => t.id === id) ? 'queued' : list.some((t) => t.id === id) ? 'list' : null;
  const byId = (id: UniqueIdentifier) => upNext.find((t) => t.id === id);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  /** Where the dragged song lands over `overId`: before or after that row, or at the end of the queue. */
  const landing = (activeId: UniqueIdentifier, overId: UniqueIdentifier | undefined) => {
    const from = sectionOf(activeId);
    if (!from || overId === undefined || overId === activeId) return null;
    if (overId === QUEUED_END)
      return from === 'list' ? { section: 'queued' as const, index: queued.length } : null;
    const to = sectionOf(overId);
    if (!to || (from === 'queued' && to === 'list')) return null;
    const tracks = to === 'queued' ? queued : list;
    const overIndex = tracks.findIndex((t) => t.id === overId);
    if (from !== to) return { section: to, index: overIndex, side: 'before' as const };
    const fromIndex = tracks.findIndex((t) => t.id === activeId);
    return {
      section: to,
      index: overIndex,
      side: fromIndex < overIndex ? ('after' as const) : ('before' as const),
    };
  };

  const onDragStart = ({ active }: DragStartEvent) => setDragId(Number(active.id));
  const onDragOver = ({ active, over }: DragOverEvent) => {
    const land = landing(active.id, over?.id);
    setDropHint(land && over ? { id: over.id, side: 'side' in land ? land.side : 'before' } : null);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const land = landing(active.id, over?.id);
    if (land) store().moveInUpNext(Number(active.id), land.section, land.index);
    setDragId(null);
    setDropHint(null);
  };
  const onDragCancel = () => {
    setDragId(null);
    setDropHint(null);
  };

  const title = (id: UniqueIdentifier) => byId(id)?.title || 'Untitled song';
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${title(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over && over.id !== QUEUED_END
        ? `${title(active.id)} is over ${title(over.id)}.`
        : `${title(active.id)} is at the end of Queued by you.`,
    onDragEnd: ({ active }) => `Dropped ${title(active.id)}.`,
    onDragCancel: ({ active }) => `Stopped moving ${title(active.id)}.`,
  };

  const dragging = dragId !== null ? byId(dragId) : undefined;
  const showQueuedZone = dragging !== undefined && sectionOf(dragging.id) === 'list';
  const rowProps = (track: MusicTrack) => ({
    track,
    cover: covers.get(track.id),
    hint: dropHint?.id === track.id ? dropHint.side : null,
    faded: dragId === track.id,
  });

  return (
    <Portal>
      <section
        ref={setPanel}
        aria-label="Up next"
        className="fixed right-5 flex w-[400px] max-w-[calc(100vw-40px)] flex-col overflow-hidden rounded-2xl border border-gray-4 bg-white shadow-[0_14px_36px_#000000AA] dark:border-dark-3 dark:bg-dark-5"
        style={
          {
            ...(accent && { '--music-accent': accent.accent, '--music-accent-2': accent.accent2 }),
            zIndex: MUSIC_UP_NEXT_Z_INDEX,
            bottom: 'calc(112px + var(--safe-area-inset-bottom) + 12px)',
            maxHeight:
              'calc(100dvh - var(--header-height, 0px) - 112px - var(--safe-area-inset-bottom) - 24px)',
          } as CSSProperties
        }
      >
        <PanelHeader summary={upNextSummary(upNext)} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NowPlaying track={current} cover={covers.get(current.id)} playing={playing} />
          {!upNext.length && !dragging ? (
            <p className={clsx('px-[18px] py-4 text-sm', dimmed)}>
              Nothing queued. Add songs with Add to up next.
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              accessibility={{ announcements }}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragEnd={onDragEnd}
              onDragCancel={onDragCancel}
            >
              <div className="flex flex-col gap-0.5 px-2.5 pb-2.5 pt-1.5">
                {(queued.length > 0 || showQueuedZone) && (
                  <SectionLabel>QUEUED BY YOU</SectionLabel>
                )}
                <SortableContext items={queued.map((t) => t.id)}>
                  {queued.map((track) => (
                    <UpNextRow key={track.id} {...rowProps(track)} />
                  ))}
                </SortableContext>
                {showQueuedZone && (
                  <QueuedEndZone empty={!queued.length} active={dropHint?.id === QUEUED_END} />
                )}
                {list.length > 0 && (
                  <SectionLabel>
                    {listName ? `NEXT FROM ${listName.toUpperCase()}` : 'NEXT IN LINE'}
                  </SectionLabel>
                )}
                <SortableContext items={list.map((t) => t.id)}>
                  {list.map((track) => (
                    <UpNextRow key={track.id} {...rowProps(track)} />
                  ))}
                </SortableContext>
              </div>
              <DragOverlay>
                {dragging ? (
                  <RowContent track={dragging} cover={covers.get(dragging.id)} className={LIFTED} />
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </section>
    </Portal>
  );
}

function PanelHeader({ summary }: { summary: string }) {
  const shuffle = useMusicPlayerStore((s) => s.shuffle);
  const repeat = useMusicPlayerStore((s) => s.repeat);
  // System toggles in the panel stay Civitai blue (Pencil `uGWPy`).
  const toggle = (on: boolean) =>
    clsx(
      'flex size-[30px] items-center justify-center rounded-lg hover:bg-gray-1 dark:hover:bg-dark-4',
      on ? 'text-blue-6 dark:text-blue-4' : dimmed
    );
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-gray-3 px-[18px] py-4 dark:border-dark-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={clsx('text-xl font-bold leading-tight', brightText)}>Up next</span>
        <span className={clsx('text-xs', dimmed)}>{summary}</span>
      </div>
      <PlayerTooltip label="Shuffle">
        <button
          type="button"
          aria-label="Shuffle"
          aria-pressed={shuffle}
          onClick={() => store().toggleShuffle()}
          className={toggle(shuffle)}
        >
          <IconArrowsShuffle size={16} />
        </button>
      </PlayerTooltip>
      <PlayerTooltip
        label={repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat'}
      >
        <button
          type="button"
          aria-label="Repeat"
          aria-pressed={repeat !== 'off'}
          onClick={() => store().cycleRepeat()}
          className={toggle(repeat !== 'off')}
        >
          {repeat === 'one' ? <IconRepeatOnce size={16} /> : <IconRepeat size={16} />}
        </button>
      </PlayerTooltip>
      <button
        type="button"
        onClick={() => store().clearUpNext()}
        // Pencil `PPbvV`: blue 3 in dark.
        className="ml-1 rounded px-1 text-[13px] font-semibold text-blue-6 hover:underline dark:text-blue-3"
      >
        Clear
      </button>
    </div>
  );
}

function NowPlaying({
  track,
  cover,
  playing,
}: {
  track: MusicTrack;
  cover?: PlayerSongCover;
  playing: boolean;
}) {
  return (
    <div
      className="relative flex items-center gap-3 px-[18px] py-3.5"
      style={{ background: `linear-gradient(90deg, ${accentAt(33)}, transparent)` }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ backgroundColor: ACCENT }}
      />
      <div className="rounded-[10px]" style={{ boxShadow: `0 3px 14px ${accentAt(60)}` }}>
        <SongArt url={cover?.url} width={48} iconSize={22} className="size-12 rounded-[10px]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={clsx('truncate text-[17px] font-bold leading-tight', brightText)}>
          {track.title || 'Untitled song'}
        </span>
        <span className="truncate text-xs font-medium" style={{ color: ACCENT }}>
          {track.creator.username}
        </span>
      </div>
      <Equalizer playing={playing} />
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className={clsx('truncate px-4 pb-1 pt-2.5 text-[11px] font-semibold', dimmed)}>
      {children}
    </div>
  );
}

/** Pencil `gM8m8`: where the dragged row will land. */
function DropIndicator() {
  return <div aria-hidden className="h-0.5 rounded-[1px]" style={{ backgroundColor: ACCENT }} />;
}

function QueuedEndZone({ empty, active }: { empty: boolean; active: boolean }) {
  const { setNodeRef } = useDroppable({ id: QUEUED_END });
  return (
    <div ref={setNodeRef} className={clsx('flex flex-col justify-end', empty ? 'h-10' : 'h-2')}>
      {active && <DropIndicator />}
    </div>
  );
}

function UpNextRow({
  track,
  cover,
  hint,
  faded,
}: {
  track: MusicTrack;
  cover?: PlayerSongCover;
  hint: 'before' | 'after' | null;
  faded: boolean;
}) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners } = useSortable({ id: track.id });
  const title = track.title || 'Untitled song';
  return (
    // Rows stay in place while dragging; the indicator shows the target (Pencil `gM8m8`).
    <div ref={setNodeRef} className="flex flex-col gap-0.5">
      {hint === 'before' && <DropIndicator />}
      <RowContent
        track={track}
        cover={cover}
        className={clsx(faded && 'opacity-40')}
        handle={
          <PlayerTooltip label="Drag to reorder">
            <button
              ref={setActivatorNodeRef}
              type="button"
              {...attributes}
              {...listeners}
              aria-label={`Reorder ${title}`}
              aria-roledescription="sortable"
              className={clsx(
                'flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded',
                dimmed
              )}
            >
              <IconGripVertical size={16} />
            </button>
          </PlayerTooltip>
        }
        remove={
          <PlayerTooltip label="Remove">
            <button
              type="button"
              aria-label={`Remove ${title} from up next`}
              onClick={() => store().removeFromUpNext(track.id)}
              className="flex size-6 shrink-0 items-center justify-center rounded text-gray-9 opacity-0 hover:bg-gray-2 focus-visible:opacity-100 group-hover:opacity-100 dark:text-dark-0 dark:hover:bg-dark-4"
            >
              <IconX size={16} />
            </button>
          </PlayerTooltip>
        }
      />
      {hint === 'after' && <DropIndicator />}
    </div>
  );
}

function RowContent({
  track,
  cover,
  className,
  handle,
  remove,
}: {
  track: MusicTrack;
  cover?: PlayerSongCover;
  className?: string;
  handle?: ReactNode;
  remove?: ReactNode;
}) {
  const title = track.title || 'Untitled song';
  return (
    <div
      className={clsx(
        'group flex items-center gap-3 rounded-[10px] p-2 hover:bg-gray-1 dark:hover:bg-dark-4',
        className
      )}
    >
      {handle ?? (
        <span className={clsx('flex size-6 shrink-0 items-center justify-center', brightText)}>
          <IconGripVertical size={16} />
        </span>
      )}
      <button
        type="button"
        aria-label={`Play ${title}`}
        onClick={() => store().playFromUpNext(track.id)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <SongArt url={cover?.url} width={44} iconSize={20} className="size-11 rounded-lg" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={clsx('truncate text-[15px] font-semibold leading-tight', brightText)}>
            {title}
          </span>
          <span className={clsx('truncate text-xs', dimmed)}>{track.creator.username}</span>
        </span>
        <span className={clsx('shrink-0 text-xs', dimmed)}>
          {formatPlaybackTime(track.durationSec)}
        </span>
      </button>
      {remove ?? <span className="size-6 shrink-0" />}
    </div>
  );
}
