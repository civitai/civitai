import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { useAppContext } from '~/providers/AppProvider';
import type { BlobData } from '~/shared/orchestrator/workflow-data';

import type { BlobHeaderVerdict } from './blobHeaderVerdict';
import { greenBlockedReason, parseBlobHeaderVerdict } from './blobHeaderVerdict';

// On green, new outputs become `available` before their `nsfwLevel` reaches the workflow data,
// so they would load as the orchestrator's blurred copy. The blob endpoint waits for the scan
// and returns the verdict in headers, so we fetch it here instead of rendering `src` directly.

type CheckState =
  | { status: 'pending' }
  | { status: 'blocked'; blockedReason: string }
  | { status: 'ok'; src: string };

const verdicts = new Map<string, BlobHeaderVerdict>();
const objectUrls = new Map<string, string>();
const inFlight = new Set<string>();
let blockedIds: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version++;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getVersion = () => version;
const getBlockedIds = () => blockedIds;

type PrivateGenMetadata = { isPrivateGeneration?: boolean } | undefined;

function isPrivateGeneration(blob: BlobData) {
  return (
    (blob.workflow.metadata as PrivateGenMetadata)?.isPrivateGeneration ??
    (blob.step.metadata as PrivateGenMetadata)?.isPrivateGeneration ??
    false
  );
}

// A failed or inconclusive check stores nothing: the output stays hidden until the rating
// reaches the workflow data, and a remount retries.
async function check(blob: BlobData, src: string) {
  if (inFlight.has(src) || verdicts.has(blob.id)) return;
  inFlight.add(src);
  try {
    const response = await fetch(src, { mode: 'cors', credentials: 'omit' });
    const verdict = parseBlobHeaderVerdict(response);
    if (!verdict) return;
    if (greenBlockedReason(verdict, isPrivateGeneration(blob))) {
      blockedIds = new Set(blockedIds).add(blob.id);
    } else {
      objectUrls.set(src, URL.createObjectURL(await response.blob()));
    }
    verdicts.set(blob.id, verdict);
  } catch {
    // Network or CORS failure; see above.
  } finally {
    inFlight.delete(src);
    notify();
  }
}

function needsCheck(blob: BlobData, green: boolean) {
  return green && blob.type === 'image' && blob.available && !blob.nsfwLevel && !blob.blockedReason;
}

function headerBlockedReason(blob: BlobData) {
  const verdict = verdicts.get(blob.id);
  return verdict && greenBlockedReason(verdict, isPrivateGeneration(blob));
}

export function useBlobHeaderBlockedReason(blob: BlobData): string | undefined {
  const { domain } = useAppContext();
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return needsCheck(blob, domain.green) ? headerBlockedReason(blob) : undefined;
}

function isUnresolved(blob: BlobData, green: boolean) {
  return needsCheck(blob, green) && (!verdicts.has(blob.id) || !!headerBlockedReason(blob));
}

/** True while the output must not expose its URL: its check is pending, failed or blocked. */
export function useBlobHeaderUnresolved(blob: BlobData): boolean {
  const { domain } = useAppContext();
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return isUnresolved(blob, domain.green);
}

/** Predicate form of `useBlobHeaderUnresolved`, for filtering lists of outputs. */
export function useBlobHeaderUnresolvedFilter(): (blob: BlobData) => boolean {
  const { domain } = useAppContext();
  const current = useSyncExternalStore(subscribe, getVersion, getVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((blob: BlobData) => isUnresolved(blob, domain.green), [domain.green, current]);
}

export function useBlobHeaderBlockedIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getBlockedIds, getBlockedIds);
}

export function useBlobHeaderCheckedSrc(blob: BlobData, src: string): CheckState {
  const { domain } = useAppContext();
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const enabled = needsCheck(blob, domain.green);

  // The fetched copy is revoked once its <img> loads; this mount keeps rendering that URL so the
  // element is not reloaded, while a later mount falls back to `src`.
  const pinned = useRef<{ src: string; objectUrl?: string } | undefined>(undefined);

  useEffect(() => {
    if (enabled) void check(blob, src);
  }, [enabled, blob.id, src]); // eslint-disable-line react-hooks/exhaustive-deps

  if (enabled) {
    const blockedReason = headerBlockedReason(blob);
    if (blockedReason) return { status: 'blocked', blockedReason };
    if (!verdicts.has(blob.id)) return { status: 'pending' };
  }
  if (pinned.current?.src !== src || !pinned.current.objectUrl)
    pinned.current = { src, objectUrl: objectUrls.get(src) };
  return { status: 'ok', src: pinned.current.objectUrl ?? src };
}

/** Frees the fetched copy behind `src`; call once its <img> has loaded. */
export function releaseBlobHeaderCheckedSrc(src: string) {
  const objectUrl = objectUrls.get(src);
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  objectUrls.delete(src);
}
