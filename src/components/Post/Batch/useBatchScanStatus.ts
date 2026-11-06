import { useEffect, useMemo, useRef } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';
import { useBatchComposerStore } from './batch-composer.store';
import { isScanningMedia, scanPollInterval } from './batch-composer.utils';

/** Signals arrive one per image; a burst of them is one refetch. */
const SIGNAL_REFETCH_DELAY_MS = 300;

/**
 * Keeps every persisted entry's scan fields current: polls `getBatchMediaStatus` while any scan
 * is pending (see `scanPollInterval`) and refetches at once when the ingestion signal names one
 * of this batch's images. An id the server stops answering is dropped from the grid, which is
 * also how a reloaded draft sheds rows that expired or were adopted elsewhere.
 */
export function useBatchScanStatus() {
  const [media, applyScanStatus] = useBatchComposerStore((state) => [
    state.media,
    state.applyScanStatus,
  ]);
  const idsKey = media
    .flatMap((item) => (item.imageId === undefined ? [] : [item.imageId]))
    .sort((a, b) => a - b)
    .join(',');
  const ids = useMemo(() => (idsKey ? idsKey.split(',').map(Number) : []), [idsKey]);
  const pending = media.some(isScanningMedia);

  const pendingSince = useRef<number | null>(null);
  if (!pending) pendingSince.current = null;
  else if (pendingSince.current === null) pendingSince.current = Date.now();

  const query = trpc.post.getBatchMediaStatus.useQuery(
    { ids },
    {
      enabled: ids.length > 0,
      refetchInterval: () =>
        scanPollInterval({ pending, pendingSince: pendingSince.current, now: Date.now() }),
      refetchOnWindowFocus: pending,
    }
  );

  const { data, isSuccess, isPlaceholderData, refetch } = query;
  useEffect(() => {
    if (!isSuccess || isPlaceholderData || !data) return;
    applyScanStatus(ids, data.images);
  }, [data, isSuccess, isPlaceholderData, ids, applyScanStatus]);

  const idSet = useMemo(() => new Set(ids), [ids]);
  const signalTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useSignalConnection(SignalMessages.ImageIngestionStatus, ({ imageId }: { imageId: number }) => {
    if (!idSet.has(imageId)) return;
    clearTimeout(signalTimer.current);
    signalTimer.current = setTimeout(() => void refetch(), SIGNAL_REFETCH_DELAY_MS);
  });
  useEffect(() => () => clearTimeout(signalTimer.current), []);
}
