import { Badge, BadgeProps, Progress, Text, Tooltip } from '@mantine/core';
import { IconPhoto } from '@tabler/icons-react';
import { useState } from 'react';
import { GenerationRequestStatus } from '~/server/common/enums';
import { generationStatusColors } from '~/shared/constants/generation.constants';

export function GenerationStatusBadge({
  status,
  complete,
  processing = 0,
  quantity,
  tooltipLabel,
  progress,
  ...badgeProps
}: {
  status: GenerationRequestStatus;
  processing?: number;
  complete: number;
  quantity: number;
  tooltipLabel?: string;
  progress?: boolean;
} & BadgeProps) {
  const [opened, setOpened] = useState(false);
  const toggleOpened = () => {
    if (tooltipLabel) setOpened((o) => !o);
  };

  return (
    <Tooltip
      label={tooltipLabel}
      withArrow
      color="dark"
      maw={300}
      multiline
      withinPortal
      opened={opened}
    >
      <Badge
        variant="light"
        size="sm"
        color={generationStatusColors[status]}
        radius="lg"
        h={22}
        onMouseEnter={toggleOpened}
        onMouseLeave={toggleOpened}
        {...badgeProps}
      >
        <div className="flex items-center gap-1">
          <IconPhoto size={16} />
          <Text size="sm" inline weight={500}>
            {status !== GenerationRequestStatus.Succeeded ? `${complete}/${quantity}` : complete}
          </Text>
          {progress && status === GenerationRequestStatus.Processing && (
            <Progress
              value={(complete / quantity) * 100}
              animate
              sections={[
                { value: (complete / quantity) * 100, color: 'green' },
                { value: (processing / quantity) * 100, color: 'yellow' },
              ]}
              w={40}
              h={10}
              className="ml-1"
              styles={{
                root: {
                  opacity: 0.5,
                },
                bar: {
                  transition: 'width 200ms, left 200ms',
                },
              }}
            />
          )}
        </div>
      </Badge>
    </Tooltip>
  );
}
