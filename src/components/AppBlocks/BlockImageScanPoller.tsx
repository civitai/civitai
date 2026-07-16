import { useEffect, useRef } from 'react';
import { nextPollDelay } from '~/components/Apps/assetPolling';
import { classifyScanThrow, type BlockImageScanResult } from './blockImageScanLogic';
import { trpc } from '~/utils/trpc';

/**
 * App Blocks (Phase-2b) — the HOST-mounted async scan poller behind the
 * non-blocking cosmetic-image upload. It is mounted by PageBlockHost (NOT the
 * upload modal) so it SURVIVES the modal's close: the modal resolves EARLY on
 * persist and unmounts, while this component keeps polling the authoritative
 * `blockImageUpload.gate` in the background until the scan lands, then reports
 * the verdict ONCE via `onResult`. The host forwards that verdict to the block
 * as the parent→block `IMAGE_SCAN_RESOLVED` push and unmounts this poller.
 *
 * It renders nothing. The gate + the pure {@link classifyScanThrow} remain the
 * security boundary — this only drives the poll schedule (the SAME `nextPollDelay`
 * budget the blocking modal uses) and maps each outcome to a
 * {@link BlockImageScanResult}:
 *   - gate `ready`        → `{ status: 'scanned', image }` (moderated projection).
 *   - gate `pending`      → re-poll on the backoff schedule until the budget is
 *                           spent → `{ status: 'error' }` (retryable timeout).
 *   - THROWN BAD_REQUEST  → `{ status: 'blocked', reason }` (terminal moderation).
 *   - THROWN other/network→ `{ status: 'error', message }` (retryable).
 *
 * `onResult` fires AT MOST ONCE (a `done` guard) — a late poll landing after the
 * verdict, or an unmount mid-flight, can never emit a second verdict.
 */
export function BlockImageScanPoller({
  imageId,
  onResult,
}: {
  imageId: number;
  onResult: (result: BlockImageScanResult) => void;
}) {
  const gateMutation = trpc.blockImageUpload.gate.useMutation();

  // Keep the latest `mutateAsync` / `onResult` in refs so the polling effect can
  // run once (keyed by imageId) without re-subscribing on every render — react-
  // query recreates `mutateAsync` across renders, and the caller may pass a fresh
  // `onResult` closure each render.
  const mutateRef = useRef(gateMutation.mutateAsync);
  mutateRef.current = gateMutation.mutateAsync;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    let cancelled = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: BlockImageScanResult) => {
      if (done || cancelled) return;
      done = true;
      onResultRef.current(result);
    };

    async function poll(attempt: number) {
      if (cancelled || done) return;
      let res: Awaited<ReturnType<typeof gateMutation.mutateAsync>>;
      try {
        res = await mutateRef.current({ imageId });
      } catch (err) {
        finish(classifyScanThrow(err));
        return;
      }
      if (cancelled || done) return;
      if (res.status === 'ready') {
        finish({
          status: 'scanned',
          image: {
            imageId: res.imageId,
            nsfwLevel: res.nsfwLevel,
            contentRating: res.contentRating,
            url: res.url,
          },
        });
        return;
      }
      // Still scanning — schedule the next poll while budget remains.
      const delayMs = nextPollDelay(attempt);
      if (delayMs === null) {
        finish({ status: 'error', message: 'Image scan timed out — please try again.' });
        return;
      }
      timer = setTimeout(() => void poll(attempt + 1), delayMs);
    }

    void poll(0);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll once per imageId;
    // mutateAsync/onResult are read via refs so they must NOT re-arm the effect.
  }, [imageId]);

  return null;
}
