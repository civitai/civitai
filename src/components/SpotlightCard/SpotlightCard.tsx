import type { PaperProps } from '@mantine/core';
import { Paper } from '@mantine/core';
import { useCallback, useState } from 'react';

export function SpotlightCard({
  children,
  borderColor,
  bg,
  ...rest
}: {
  children: React.ReactNode;
  borderColor: string;
  bg: string;
} & Omit<PaperProps, 'children'>) {
  const [spotlight, setSpotlight] = useState({ x: 0, y: 0, opacity: 0 });

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setSpotlight({ x: e.clientX - rect.left, y: e.clientY - rect.top, opacity: 1 });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setSpotlight((s) => ({ ...s, opacity: 0 }));
  }, []);

  return (
    <div
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={
        {
          position: 'relative',
          borderRadius: 'var(--mantine-radius-md)',
          '--spotlight-x': `${spotlight.x}px`,
          '--spotlight-y': `${spotlight.y}px`,
          '--spotlight-opacity': spotlight.opacity,
        } as React.CSSProperties
      }
    >
      <div
        style={{
          position: 'absolute',
          inset: -1,
          borderRadius: 'inherit',
          background: `radial-gradient(400px circle at ${spotlight.x}px ${spotlight.y}px, rgba(255,255,255,0.04), transparent 70%)`,
          opacity: spotlight.opacity,
          transition: 'opacity 0.5s ease',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      <Paper
        p="md"
        radius="md"
        style={{
          position: 'relative',
          zIndex: 1,
          background: bg,
          border: `1px solid ${borderColor}`,
        }}
        {...rest}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            background: `radial-gradient(500px circle at ${spotlight.x}px ${spotlight.y}px, rgba(255,255,255,0.005), transparent 60%)`,
            opacity: spotlight.opacity,
            transition: 'opacity 0.5s ease',
            pointerEvents: 'none',
          }}
        />
        {children}
      </Paper>
    </div>
  );
}
