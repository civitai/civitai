import { ActionIcon } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconClock } from '@tabler/icons-react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

export function DurationIcon({ seconds }: { seconds: number }) {
  const [opened, setOpened] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const label = `Duration: ${seconds}s`;

  useEffect(() => {
    if (!opened) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpened(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [opened]);

  // Mouse hover opens it; a tap toggles it, since touch emits a mouseleave right after the tap.
  return (
    <Tooltip label={label} opened={opened} withinPortal>
      <ActionIcon
        ref={ref}
        variant="subtle"
        color="yellow"
        size="sm"
        aria-label={label}
        data-testid="duration-icon"
        onClick={() => setOpened((o) => !o)}
        onPointerEnter={(e: ReactPointerEvent) => e.pointerType === 'mouse' && setOpened(true)}
        onPointerLeave={(e: ReactPointerEvent) => e.pointerType === 'mouse' && setOpened(false)}
      >
        <IconClock size={16} />
      </ActionIcon>
    </Tooltip>
  );
}
