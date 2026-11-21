import { Button, Loader, Text } from '@mantine/core';
import { IconAlertTriangle, IconWand } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import type { StickerTrackKey } from '~/shared/utils/sticker-track';
import {
  autoTrackPollDelay,
  discardAutoTrackKeys,
  mergeAutoTrackKeys,
} from '~/shared/utils/sticker-auto-track-keys';
import { useStickerAutoTrackStore as useRuns } from '~/store/sticker-auto-track.store';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';
import { useStickerPlacementDraftStore as useDrafts } from '~/store/sticker-placement-draft.store';
import { trpc } from '~/utils/trpc';

const GENERIC_FAILURE = 'Something went wrong on our side. Your sticker stays where you put it.';

/** The server's own words for a refusal it explains (the daily limit, a video that has ended). */
function startFailure(error: { message?: string; data?: { code?: string } | null }) {
  const code = error.data?.code;
  if (code !== 'TOO_MANY_REQUESTS' && code !== 'BAD_REQUEST') return GENERIC_FAILURE;
  const message = (error.message ?? '').replace(/^placement: /, '');
  return message ? message[0].toUpperCase() + message.slice(1) : GENERIC_FAILURE;
}

const formatElapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export const useAutoTrackRun = (draftId: string | undefined) =>
  useRuns((state) => (draftId ? state.runs[draftId] : undefined));

/** Starts a run from the draft's pose at the playhead. Hidden while this draft is tracking. */
export function AutoTrackButton({
  draft,
  playheadMs,
}: {
  draft: StickerDraft;
  playheadMs: number;
}) {
  const run = useAutoTrackRun(draft.id);
  const start = trpc.placement.startStickerAutoTrack.useMutation();
  if (run?.phase === 'tracking') return null;

  const onStart = () => {
    const startMs = Math.max(0, Math.round(playheadMs));
    const runs = useRuns.getState();
    start.mutate(
      {
        imageId: draft.imageId,
        pose: { x: draft.x, y: draft.y, scale: draft.scale, rotation: draft.rotation },
        startMs,
      },
      {
        onSuccess: ({ workflowId }) =>
          runs.set(draft.id, { phase: 'tracking', workflowId, startMs, startedAt: Date.now() }),
        onError: (error) => runs.set(draft.id, { phase: 'failed', message: startFailure(error) }),
      }
    );
  };

  return (
    <Button
      size="xs"
      radius="xl"
      // Solid: it sits on the video, where a tinted or text-only button disappears.
      variant="filled"
      className="bg-blue-6 text-white hover:bg-blue-7"
      leftSection={<IconWand size={14} />}
      loading={start.isPending}
      onClick={onStart}
    >
      Auto-track
    </Button>
  );
}

/**
 * The run's state where the timeline sits. Tracking polls on `autoTrackPollDelay` and stops at
 * an answer; a track that lands is merged into the draft's keys and plays from its start.
 */
export function AutoTrackPanel({ draft, video }: { draft: StickerDraft; video: HTMLVideoElement }) {
  const run = useAutoTrackRun(draft.id);
  if (!run) return null;
  if (run.phase === 'tracking') return <Tracking draft={draft} run={run} video={video} />;
  if (run.phase === 'ready') return <Ready draft={draft} run={run} />;
  return <Failed draft={draft} message={run.message} />;
}

function Tracking({
  draft,
  run,
  video,
}: {
  draft: StickerDraft;
  run: Extract<NonNullable<ReturnType<typeof useAutoTrackRun>>, { phase: 'tracking' }>;
  video: HTMLVideoElement;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // A run can outlive this panel; its age only counts against it once an answer read since
  // mounting says it is still going, or the read keeps failing.
  const mountedAt = useRef(Date.now());
  const { data, error, dataUpdatedAt, errorUpdatedAt } =
    trpc.placement.getStickerAutoTrack.useQuery(
      { workflowId: run.workflowId },
      {
        refetchInterval: (query) =>
          query.state.data && query.state.data.status !== 'running'
            ? false
            : autoTrackPollDelay(Date.now() - run.startedAt) ?? false,
        refetchIntervalInBackground: true,
        retry: 2,
      }
    );

  useEffect(() => {
    const runs = useRuns.getState();
    // The answer is acted on once: a tick can land between setting the run and this unmounting.
    if (runs.runs[draft.id] !== run) return;
    if (
      error?.data?.code === 'NOT_FOUND' ||
      (data && data.status !== 'running' && data.status !== 'succeeded')
    )
      return runs.set(draft.id, { phase: 'failed', message: GENERIC_FAILURE });
    if (data?.status === 'succeeded') {
      const current = useDrafts.getState().drafts.find((d) => d.id === draft.id);
      const before: StickerTrackKey[] = current?.motion?.keys ?? [];
      const merged = mergeAutoTrackKeys(before, data.track, data.startMs);
      if (!merged)
        return runs.set(draft.id, {
          phase: 'failed',
          message:
            'This sticker already has as many keys as it can hold. Remove some and try again.',
        });
      const { keys, startMs, endMs } = merged;
      const added = keys.filter((key) => !before.includes(key));
      const hides = added.filter(
        (key, i) => key.o === 0 && (i === 0 || added[i - 1].o !== 0)
      ).length;
      useDrafts.getState().setKeys(draft.id, keys);
      runs.set(draft.id, { phase: 'ready', added: added.length, hides, before, startMs, endMs });
      video.currentTime = data.startMs / 1000;
      void video.play().catch(() => undefined);
      return;
    }
    const answered = Math.max(dataUpdatedAt ?? 0, errorUpdatedAt ?? 0) > mountedAt.current;
    if (answered && autoTrackPollDelay(now - run.startedAt) === null)
      runs.set(draft.id, {
        phase: 'failed',
        message: 'This one took too long to track. Try again in a bit.',
      });
  }, [data, error, dataUpdatedAt, errorUpdatedAt, now, draft.id, run, video]);

  return (
    <div role="status" className="flex items-center gap-3">
      <Loader size="xs" color="blue" />
      <div className="min-w-0 flex-1">
        <Text size="sm" fw={600}>
          Tracking your sticker…{' '}
          <span className="tabular-nums">{formatElapsed(now - run.startedAt)}</span>
        </Text>
        <Text size="xs" c="dimmed">
          Usually under a minute and a half. Nothing is placed until you press Place.
        </Text>
      </div>
      <Button
        size="xs"
        variant="subtle"
        color="gray"
        onClick={() => useRuns.getState().clear(draft.id)}
      >
        Cancel
      </Button>
    </div>
  );
}

function Ready({
  draft,
  run,
}: {
  draft: StickerDraft;
  run: Extract<NonNullable<ReturnType<typeof useAutoTrackRun>>, { phase: 'ready' }>;
}) {
  const runs = useRuns.getState();
  return (
    <div className="mb-2 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <Text size="sm" fw={600}>
          Auto-track ready
        </Text>
        <Text size="xs" c="dimmed">
          {run.added} {run.added === 1 ? 'key' : 'keys'}
          {run.hides ? ` · hidden ${run.hides === 1 ? 'once' : `${run.hides} times`}` : ''}
        </Text>
      </div>
      <Button
        size="xs"
        variant="subtle"
        color="gray"
        onClick={() => {
          const current = useDrafts.getState().drafts.find((d) => d.id === draft.id);
          useDrafts
            .getState()
            .setKeys(draft.id, discardAutoTrackKeys(current?.motion?.keys ?? [], run.before, run));
          runs.clear(draft.id);
        }}
      >
        Discard
      </Button>
      <Button size="xs" radius="xl" onClick={() => runs.clear(draft.id)}>
        Keep
      </Button>
    </div>
  );
}

function Failed({ draft, message }: { draft: StickerDraft; message: string }) {
  const runs = useRuns.getState();
  return (
    <div role="alert" className="flex items-start gap-3">
      <IconAlertTriangle size={18} className="mt-0.5 shrink-0 text-yellow-6" />
      <div className="min-w-0 flex-1">
        <Text size="sm" fw={600}>
          Couldn&apos;t track this one
        </Text>
        <Text size="xs" c="dimmed">
          {message}
        </Text>
      </div>
      <Button
        size="xs"
        variant="subtle"
        color="gray"
        onClick={() => {
          runs.clear(draft.id);
          useDrafts.getState().setMotion(draft.id, false);
        }}
      >
        Keep it still
      </Button>
      <Button size="xs" radius="xl" onClick={() => runs.clear(draft.id)}>
        Key it by hand
      </Button>
    </div>
  );
}
