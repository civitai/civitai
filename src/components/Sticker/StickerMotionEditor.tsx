import {
  ActionIcon,
  Button,
  Portal,
  SegmentedControl,
  Slider,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconDiamond,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconTrash,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { PAGE_MODAL_Z_INDEX } from '~/components/Dialog/Templates/PageModal';
import { STICKER_EDITOR_ATTR } from '~/components/EmblaCarousel/watchTouchDrag';
import { Menu } from '~/components/MantineOverlays';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StickerTrackEase, StickerTrackKey } from '~/shared/utils/sticker-track';
import { STICKER_TRACK_EASES } from '~/shared/utils/sticker-track';
import {
  editKey,
  keyIndexAt,
  keyMinShown,
  removeKey,
  snapKeyOpacity,
  STICKER_KEY_STEP_MS,
  STICKER_KEYS_TOO_FAINT,
  stickerKeysRefusal,
  upsertKey,
} from '~/shared/utils/sticker-track-edit';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';
import { useStickerPlacementDraftStore as useStore } from '~/store/sticker-placement-draft.store';

/** Room the media gives up while the timeline is open, so the panel does not cover it. */
export const STICKER_TIMELINE_SPACE = 132;

const EASE_NAMES: Record<StickerTrackEase, string> = {
  smooth: 'Smooth',
  linear: 'Linear',
  in: 'Ease in',
  out: 'Ease out',
  jump: 'Jump',
};

const EASE_PATHS: Record<StickerTrackEase, string> = {
  smooth: 'M2 14 C7 14 9 2 14 2',
  linear: 'M2 14 L14 2',
  in: 'M2 14 C8 14 14 8 14 2',
  out: 'M2 14 C2 8 8 2 14 2',
  jump: 'M2 14 H14 V2',
};

const EaseIcon = ({ ease }: { ease: StickerTrackEase }) => (
  <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
    <path d={EASE_PATHS[ease]} fill="none" stroke="currentColor" strokeWidth={1.8} />
  </svg>
);

const formatTime = (ms: number) => {
  const seconds = Math.max(ms, 0) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
};

/**
 * True when a key press belongs to a field or a slider rather than to the editor. A radio or a
 * checkbox does not count: the Static | Movement switch is one, and keeps focus after a click.
 */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    (target instanceof HTMLInputElement
      ? !['radio', 'checkbox', 'button'].includes(target.type)
      : ['TEXTAREA', 'SELECT'].includes(target.tagName)) ||
    target.getAttribute('role') === 'slider');

/**
 * A key press inside a dialog (the Buzz purchase modal, say) is the dialog's, not the editor's.
 * The dialog that holds the video is the editor's own host (the image detail modal), not one on top.
 */
const inDialog = (target: EventTarget | null, video: HTMLVideoElement) => {
  const dialog =
    target instanceof Element ? target.closest('[role="dialog"], [aria-modal="true"]') : null;
  return !!dialog && !dialog.contains(video);
};

/**
 * Whether the selected draft on `imageId` has its timeline open, for the media to make room
 * and put its own controls away.
 */
export const useStickerTimelineOpen = (imageId: number) =>
  useStore((state) => {
    if (state.targetImageId !== imageId || state.trayOpen) return false;
    const selected = state.drafts.find((draft) => draft.id === state.selectedDraftId);
    return !!selected?.motion?.on;
  });

/**
 * Static | Movement for the selected draft on a video, and in Movement the timeline above it:
 * play, frame steps, a scrub bar with the draft's keys, and an inspector for the key under the
 * playhead. The playhead is the video's own time, so one clock plays every draft.
 */
export function StickerMotionEditor({ video }: { video: HTMLVideoElement }) {
  const drafts = useStore((state) => state.drafts);
  const selectedId = useStore((state) => state.selectedDraftId);
  const trayOpen = useStore((state) => state.trayOpen);
  const previewing = useStore((state) => state.previewing);
  const playheadMs = useStore((state) => state.playheadMs);
  const selected = drafts.find((draft) => draft.id === selectedId);
  const primaryLabel = useStore((state) => (selectedId ? state.primaryLabels[selectedId] : null));
  const open = !!selected && !trayOpen;
  const moving = open && !!selected.motion?.on;

  const playing = useStore((state) => state.videoPlaying);
  const [durationMs, setDurationMs] = useState(() => videoDurationMs(video));

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const { setPlayhead, setVideoPlaying: setPlaying } = useStore.getState();
    const sync = () => setPlayhead(Math.round(video.currentTime * 1000));
    const tick = () => {
      sync();
      frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      sync();
    };
    const onMeta = () => setDurationMs(videoDurationMs(video));
    sync();
    onMeta();
    if (!video.paused) onPlay();
    else setPlaying(false);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', sync);
    video.addEventListener('loadedmetadata', onMeta);
    return () => {
      cancelAnimationFrame(frame);
      setPlaying(false);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', sync);
      video.removeEventListener('loadedmetadata', onMeta);
    };
  }, [open, video]);

  const seek = useCallback(
    (ms: number) => {
      const t = Math.min(Math.max(Math.round(ms), 0), durationMs);
      video.currentTime = t / 1000;
      useStore.getState().setPlayhead(t);
    },
    [video, durationMs]
  );

  const toggle = useCallback(() => {
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, [video]);

  // Stickers stop their own presses, so a click reaching the video is off-sticker.
  useEffect(() => {
    if (!moving) return;
    video.addEventListener('click', toggle);
    return () => video.removeEventListener('click', toggle);
  }, [moving, video, toggle]);

  const keys = selected?.motion?.keys ?? [];
  const at = keyIndexAt(keys, playheadMs);
  const refusal = moving && keys.length ? stickerKeysRefusal(keys, selected.opacity) : null;
  const setKeys = (next: StickerTrackKey[]) =>
    selected && useStore.getState().setKeys(selected.id, next);

  // Read through refs so the key listener is bound once per open, not once per frame.
  const live = useRef({ selected, keys, at, playheadMs, drafts });
  live.current = { selected, keys, at, playheadMs, drafts };

  useEffect(() => {
    if (!moving) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
      if (typing(event.target) || inDialog(event.target, video)) return;
      const { selected, keys, at, playheadMs, drafts } = live.current;
      if (!selected) return;
      const step = event.shiftKey ? 1000 : STICKER_KEY_STEP_MS;
      const store = useStore.getState();
      const act: Record<string, () => void> = {
        ' ': toggle,
        ArrowLeft: () => seek(playheadMs - step),
        ArrowRight: () => seek(playheadMs + step),
        ',': () => {
          const prev = keys.filter((key) => key.t < playheadMs - 1).at(-1);
          if (prev) seek(prev.t);
        },
        '.': () => {
          const next = keys.find((key) => key.t > playheadMs + 1);
          if (next) seek(next.t);
        },
        k: () =>
          store.setKeys(
            selected.id,
            upsertKey(keys, playheadMs, selected, keyMinShown(selected.opacity))
          ),
        Delete: () => {
          if (at >= 0 && keys.length > 1) store.setKeys(selected.id, removeKey(keys, at));
        },
        Tab: () => {
          const index = drafts.findIndex((draft) => draft.id === selected.id);
          store.select(drafts[(index + 1) % drafts.length].id);
        },
        Escape: () => store.setMotion(selected.id, false),
      };
      act.K = act.k;
      act.Backspace = act.Delete;
      const run = act[event.key];
      if (!run) return;
      event.preventDefault();
      run();
    };
    // Window capture runs before the detail carousel's document-capture arrow handler; bind here
    // or the arrows step the carousel.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [moving, seek, toggle, video]);

  // The tray covers where the editor sits, so with it open only the mode choice shows, above it.
  if (trayOpen && selected && !previewing)
    return <TrayModeToggle video={video} draftId={selected.id} moving={!!selected.motion?.on} />;
  if (!open || !selected) return null;

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 bottom-2 flex flex-col items-center gap-2 px-2"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {moving && (
        <div
          role="group"
          aria-label="Sticker timeline"
          className="w-full max-w-[560px] rounded-xl bg-black/60 px-3 py-2 text-white backdrop-blur"
        >
          <div className="flex items-center gap-2">
            <ActionIcon
              radius="xl"
              size="lg"
              color="gray"
              variant="filled"
              aria-label={playing ? 'Pause' : 'Play'}
              onClick={toggle}
            >
              {playing ? <IconPlayerPauseFilled size={16} /> : <IconPlayerPlayFilled size={16} />}
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Back one frame"
              onClick={() => seek(playheadMs - STICKER_KEY_STEP_MS)}
            >
              <IconChevronLeft size={16} />
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Forward one frame"
              onClick={() => seek(playheadMs + STICKER_KEY_STEP_MS)}
            >
              <IconChevronRight size={16} />
            </ActionIcon>
            <ScrubBar
              durationMs={durationMs}
              playheadMs={playheadMs}
              keys={keys}
              selectedKey={at}
              others={drafts.filter((draft) => draft.id !== selected.id)}
              onSeek={seek}
              onRetime={(index, t) => setKeys(editKey(keys, index, { t }))}
            />
            <Text size="xs" className="shrink-0 tabular-nums">
              {formatTime(playheadMs)} / {formatTime(durationMs)}
            </Text>
          </div>
          <KeyInspector
            draft={selected}
            keys={keys}
            index={at}
            playheadMs={playheadMs}
            onChange={setKeys}
          />
          {refusal && (
            <Text size="xs" c="red.4" mt={4} role="alert">
              {refusal === 'keys: too much fading'
                ? 'Too much fading to place: shorten or remove a fade.'
                : refusal === STICKER_KEYS_TOO_FAINT
                ? 'A key is too faint for this sticker’s opacity: raise the key or the sticker.'
                : `This movement can't be placed (${refusal}).`}
            </Text>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <ModeControl
          moving={moving}
          onChange={(movement) => {
            // Paused on a frame, so the first move sets a key where the placer is looking.
            if (movement) video.pause();
            useStore.getState().setMotion(selected.id, movement);
          }}
        />
        {primaryLabel && !previewing && !refusal && (
          // Presses the selected draft's own pay button: one way to pay, and any choice it
          // offers (free or Buzz, a use or a pack) is still made under the sticker. Gone while
          // previewing, which hides that button and the price and payee beside it.
          <Button size="xs" radius="xl" color="yellow" onClick={() => pressPrimary(selected.id)}>
            {primaryLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

function ModeControl({
  moving,
  onChange,
}: {
  moving: boolean;
  onChange: (movement: boolean) => void;
}) {
  return (
    <SegmentedControl
      size="xs"
      radius="xl"
      aria-label="Sticker mode"
      value={moving ? 'movement' : 'static'}
      onChange={(value) => onChange(value === 'movement')}
      data={[
        { label: 'Static', value: 'static' },
        { label: 'Movement', value: 'movement' },
      ]}
    />
  );
}

/** Movement closes the tray because the timeline it opens sits where the tray is. */
function TrayModeToggle({
  video,
  draftId,
  moving,
}: {
  video: HTMLVideoElement;
  draftId: string;
  moving: boolean;
}) {
  const tray = useStore((state) => state.tray);
  const [trayHeight, setTrayHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!tray) return;
    const measure = () => setTrayHeight(tray.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure);
    observer.observe(tray);
    measure();
    return () => observer.disconnect();
  }, [tray]);

  if (trayHeight == null) return null;

  return (
    <Portal>
      <div
        {...{ [STICKER_EDITOR_ATTR]: '' }}
        className="pointer-events-none flex justify-center"
        // Inline, not Tailwind: browser tests load no stylesheet, and the placement is what they check.
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: trayHeight,
          zIndex: PAGE_MODAL_Z_INDEX + 1,
        }}
      >
        <div className="pointer-events-auto" onPointerDown={(event) => event.stopPropagation()}>
          <ModeControl
            moving={moving}
            onChange={(movement) => {
              const store = useStore.getState();
              if (movement) {
                video.pause();
                // The editor's clock is off while the tray is open; the first key goes at this frame.
                store.setPlayhead(Math.round(video.currentTime * 1000));
              }
              store.setMotion(draftId, movement);
              if (movement) store.closeTray();
            }}
          />
        </div>
      </div>
    </Portal>
  );
}

function ScrubBar({
  durationMs,
  playheadMs,
  keys,
  selectedKey,
  others,
  onSeek,
  onRetime,
}: {
  durationMs: number;
  playheadMs: number;
  keys: StickerTrackKey[];
  selectedKey: number;
  others: StickerDraft[];
  onSeek: (ms: number) => void;
  onRetime: (index: number, ms: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const timeAt = (clientX: number) => {
    const rect = bar.current?.getBoundingClientRect();
    if (!rect || !rect.width) return 0;
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * durationMs;
  };
  const left = (ms: number) => `${(Math.min(ms, durationMs) / durationMs) * 100}%`;

  const scrub = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    onSeek(timeAt(event.clientX));
  };

  const grabKey = (index: number) => (event: React.PointerEvent) => {
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    let dragged = false;
    let current = index;
    const onMove = (move: PointerEvent) => {
      if (!dragged && Math.abs(move.clientX - startX) < 3) return;
      dragged = true;
      const t = Math.round(timeAt(move.clientX));
      onRetime(current, t);
      current = keysRef.current.findIndex((key) => key.t === t);
      if (current < 0) current = index;
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      if (!dragged) onSeek(keysRef.current[index]?.t ?? 0);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };
  return (
    <div
      ref={bar}
      role="slider"
      aria-label="Video time"
      aria-valuemin={0}
      aria-valuemax={durationMs}
      aria-valuenow={playheadMs}
      tabIndex={-1}
      className="relative h-8 flex-1 cursor-pointer touch-none"
      onPointerDown={scrub}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) onSeek(timeAt(event.clientX));
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-white/25" />
      <div
        className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded bg-white/70"
        style={{ width: left(playheadMs) }}
      />
      {others.flatMap((draft) =>
        draft.motion?.on
          ? draft.motion.keys.map((key) => (
              <span
                key={`${draft.id}-${key.t}`}
                data-other-key
                className="absolute bottom-0 size-1 -translate-x-1/2 rounded-full bg-white/50"
                style={{ left: left(key.t) }}
              />
            ))
          : []
      )}
      {keys.map((key, index) => (
        <span
          key={key.t}
          role="button"
          aria-label={`Key ${index + 1} at ${formatTime(key.t)}`}
          data-key-index={index}
          className={clsx(
            'absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-solid border-white',
            index === selectedKey && 'ring-2 ring-yellow-4'
          )}
          style={{ left: left(key.t), background: `rgba(255,255,255,${key.o})` }}
          onPointerDown={grabKey(index)}
        />
      ))}
      <div
        className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-yellow-4"
        style={{ left: left(playheadMs) }}
      />
    </div>
  );
}

function KeyInspector({
  draft,
  keys,
  index,
  playheadMs,
  onChange,
}: {
  draft: StickerDraft;
  keys: StickerTrackKey[];
  index: number;
  playheadMs: number;
  onChange: (keys: StickerTrackKey[]) => void;
}) {
  const key = keys[index];
  if (!key)
    return (
      <div className="mt-1 flex items-center gap-2">
        <Text size="xs" c="gray.4">
          Move, size or turn the sticker to set a key here.
        </Text>
        <UnstyledButton
          className="ml-auto flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-xs"
          onClick={() => onChange(upsertKey(keys, playheadMs, draft, keyMinShown(draft.opacity)))}
        >
          <IconDiamond size={12} />
          Key here
        </UnstyledButton>
      </div>
    );

  // A shown key times the sticker's own opacity must clear the floor, as the server checks.
  const minShown = keyMinShown(draft.opacity);
  const snapOpacity = (percent: number) => snapKeyOpacity(percent / 100, minShown);
  const last = index === keys.length - 1;

  return (
    <div className="mt-1 flex items-center gap-3">
      <Text size="xs" className="shrink-0 tabular-nums">
        Key {index + 1} · {formatTime(key.t)}
      </Text>
      {last ? (
        <Text size="xs" c="gray.4">
          Holds to end
        </Text>
      ) : (
        <Menu withinPortal position="top" shadow="md">
          <Menu.Target>
            <UnstyledButton
              aria-label="Ease"
              className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-xs"
            >
              <EaseIcon ease={key.ease} />
              {EASE_NAMES[key.ease]}
              <IconChevronDown size={12} />
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            {STICKER_TRACK_EASES.map((ease) => (
              <Menu.Item
                key={ease}
                leftSection={<EaseIcon ease={ease} />}
                onClick={() => onChange(editKey(keys, index, { ease }))}
              >
                {EASE_NAMES[ease]}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
      <div className="flex min-w-[120px] flex-1 items-center gap-2">
        <Text size="xs" aria-hidden>
          ◐
        </Text>
        <Slider
          className="flex-1"
          size="xs"
          min={0}
          max={100}
          label={null}
          thumbLabel="Key opacity"
          value={Math.round(key.o * 100)}
          onChange={(value) => onChange(editKey(keys, index, { o: snapOpacity(value) }))}
        />
        <Text size="xs" className="w-8 tabular-nums">
          {Math.round(key.o * 100)}%
        </Text>
      </div>
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label="Remove key"
        disabled={keys.length < 2}
        onClick={() => onChange(removeKey(keys, index))}
      >
        <IconTrash size={14} />
      </ActionIcon>
    </div>
  );
}

function pressPrimary(draftId: string) {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-draft-primary="${CSS.escape(draftId)}"]`
  );
  if (button && !button.disabled) button.click();
}

const videoDurationMs = (video: HTMLVideoElement) =>
  Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : 1;
