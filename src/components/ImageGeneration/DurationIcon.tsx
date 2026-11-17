import { ActionIcon } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconClock } from '@tabler/icons-react';
import { useTapTooltip } from '~/hooks/useTapTooltip';

export function DurationIcon({ seconds }: { seconds: number }) {
  const { opened, ref, triggerProps } = useTapTooltip<HTMLButtonElement>();
  const label = `Duration: ${seconds}s`;

  return (
    <Tooltip label={label} opened={opened} withinPortal>
      <ActionIcon
        ref={ref}
        variant="subtle"
        color="yellow"
        size="sm"
        aria-label={label}
        data-testid="duration-icon"
        {...triggerProps}
      >
        <IconClock size={16} />
      </ActionIcon>
    </Tooltip>
  );
}
