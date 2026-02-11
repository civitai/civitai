import { ActionIcon, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { useCallback, useRef } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';

/**
 * Lets the user drag a hero image vertically within a 16:9 frame
 * to choose which portion of the image is visible.
 * Stores a 0–100 value representing the CSS `object-position` Y%.
 */
export function HeroPositionPicker({
  url,
  position,
  onPositionChange,
  onRemove,
  className,
}: {
  url: string;
  position: number;
  onPositionChange: (pos: number) => void;
  onRemove: () => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startPos = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true;
      startY.current = e.clientY;
      startPos.current = position;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [position]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const containerHeight = containerRef.current.clientHeight;
      const delta = ((e.clientY - startY.current) / containerHeight) * -100;
      const next = Math.round(Math.min(100, Math.max(0, startPos.current + delta)));
      onPositionChange(next);
    },
    [onPositionChange]
  );

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <div style={{ position: 'relative' }} className={className}>
      <div
        ref={containerRef}
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          borderRadius: 8,
          overflow: 'hidden',
          background: '#2C2E33',
          cursor: 'grab',
          touchAction: 'none',
          userSelect: 'none',
          position: 'relative',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <img
          src={getEdgeUrl(url, { width: 720 })}
          alt="Hero"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: `center ${position}%`,
            pointerEvents: 'none',
            display: 'block',
          }}
          draggable={false}
        />
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: 8,
            background: 'linear-gradient(transparent, rgba(0, 0, 0, 0.6))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <Text size="xs" c="white" fw={500}>
            Drag to reposition
          </Text>
        </div>
      </div>
      <ActionIcon
        variant="filled"
        color="dark"
        size="xs"
        style={{ position: 'absolute', top: -8, right: -8 }}
        onClick={onRemove}
      >
        <IconX size={12} />
      </ActionIcon>
    </div>
  );
}
