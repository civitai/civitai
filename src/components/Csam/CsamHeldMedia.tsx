import { Center, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { ShownRendition } from '@civitai/shared/held-media';
import { isNotHeldAnswer, playedFraction, WATCHED_FRACTION } from '@civitai/shared/held-media';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { ModerationImageModel } from '~/server/services/image.service';

const CAPTURE = { capture: true };

/** The summary audit row, once per account opened; a refetch of the same account adds none. Each
 *  image is audited by the route as it is served. */
export function useHeldGridReport(userId: number, count: number) {
  const reportedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!count || reportedFor.current === userId) return;
    reportedFor.current = userId;
    fetch('/api/mod/held-media/grid-view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count, userId }),
      keepalive: true,
    }).catch(() => null);
  }, [userId, count]);
}

/**
 * From storage through `/api/mod/held-media`. A failed load asks the route why: only its explicit
 * not-held answer falls back to the CDN, which still serves an image nobody holds. Any other failure
 * (storage down, an unplayable video, a refused request) shows an error tile, never the CDN copy.
 */
export function CsamHeldMedia({
  image,
  onClick,
  onShown,
}: {
  image: ModerationImageModel;
  onClick: () => void;
  /** Once the file is on screen: an image whose pixels loaded, or a video WATCHED_FRACTION played. */
  onShown?: (rendition: ShownRendition) => void;
}) {
  const [state, setState] = useState<'held' | 'cdn' | 'error'>('held');
  const src = `/api/mod/held-media/${image.id}`;
  const onError = () =>
    fetch(`${src}?probe=1`)
      .then((res) => setState(isNotHeldAnswer(res) ? 'cdn' : 'error'))
      .catch(() => setState('error'));
  const shownRef = useShown(state === 'cdn' ? 'cdn-450' : 'original', onShown);
  // Native controls take clicks on a video, so it is selected by its checkbox only.
  const isVideo = image.type === 'video';

  if (state === 'cdn')
    return (
      <div ref={shownRef}>
        <EdgeMedia
          src={image.url}
          name={image.name ?? image.id.toString()}
          alt={image.name ?? undefined}
          type={image.type}
          width={450}
          placeholder="empty"
          style={{ width: '100%' }}
          html5Controls={isVideo}
          onClick={isVideo ? undefined : onClick}
        />
      </div>
    );
  if (state === 'error')
    return (
      <Center p="md" style={{ minHeight: 120 }} onClick={onClick}>
        <Text size="sm" c="dimmed" ta="center">
          Could not load this file. Reload to try again.
        </Text>
      </Center>
    );
  if (isVideo)
    return (
      <div ref={shownRef}>
        <video
          src={src}
          muted
          playsInline
          controls
          preload="metadata"
          style={{ width: '100%' }}
          onError={onError}
        />
      </div>
    );
  return (
    <div ref={shownRef}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={image.name ?? ''}
        loading="lazy"
        decoding="async"
        style={{ width: '100%' }}
        onClick={onClick}
        onError={onError}
      />
    </div>
  );
}

/**
 * Calls `onShown` once per rendition, from the media element's own events. Listened for in the
 * capture phase on a wrapper, since media events do not bubble and the CDN copy's element is
 * EdgeMedia's.
 */
function useShown(
  rendition: ShownRendition,
  onShown: ((rendition: ShownRendition) => void) | undefined
) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const reported = useRef<ShownRendition | null>(null);
  const callback = useRef(onShown);
  callback.current = onShown;

  useEffect(() => {
    if (!node) return;
    const report = () => {
      if (reported.current === rendition) return;
      reported.current = rendition;
      callback.current?.(rendition);
    };
    const onLoad = (e: Event) => {
      if (e.target instanceof HTMLImageElement && e.target.naturalWidth > 0) report();
    };
    const onProgress = (e: Event) => {
      if (e.target instanceof HTMLVideoElement && playedFraction(e.target) >= WATCHED_FRACTION)
        report();
    };
    const progress = ['timeupdate', 'pause', 'ended'] as const;
    node.addEventListener('load', onLoad, CAPTURE);
    for (const type of progress) node.addEventListener(type, onProgress, CAPTURE);
    return () => {
      node.removeEventListener('load', onLoad, CAPTURE);
      for (const type of progress) node.removeEventListener(type, onProgress, CAPTURE);
    };
  }, [node, rendition]);

  return setNode;
}
