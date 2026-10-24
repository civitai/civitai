import { Center, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { isNotHeldAnswer } from '@civitai/shared/held-media';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { ModerationImageModel } from '~/server/services/image.service';

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
}: {
  image: ModerationImageModel;
  onClick: () => void;
}) {
  const [state, setState] = useState<'held' | 'cdn' | 'error'>('held');
  const src = `/api/mod/held-media/${image.id}`;
  const onError = () =>
    fetch(`${src}?probe=1`)
      .then((res) => setState(isNotHeldAnswer(res) ? 'cdn' : 'error'))
      .catch(() => setState('error'));

  if (state === 'cdn')
    return (
      <EdgeMedia
        src={image.url}
        name={image.name ?? image.id.toString()}
        alt={image.name ?? undefined}
        type={image.type}
        width={450}
        placeholder="empty"
        style={{ width: '100%' }}
        onClick={onClick}
      />
    );
  if (state === 'error')
    return (
      <Center p="md" style={{ minHeight: 120 }} onClick={onClick}>
        <Text size="sm" c="dimmed" ta="center">
          Could not load this file. Reload to try again.
        </Text>
      </Center>
    );
  if (image.type === 'video')
    return (
      <video
        src={src}
        muted
        playsInline
        preload="metadata"
        style={{ width: '100%' }}
        onClick={onClick}
        onError={onError}
      />
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={image.name ?? ''}
      loading="lazy"
      decoding="async"
      style={{ width: '100%' }}
      onClick={onClick}
      onError={onError}
    />
  );
}
