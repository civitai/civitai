import { WorkflowStatus } from '@civitai/client';
import { Badge, BadgeProps, Progress, Text, Tooltip } from '@mantine/core';
import { IconPhoto } from '@tabler/icons-react';
import { useState } from 'react';
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
  status: WorkflowStatus;
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
          <Text size="sm" inline fw={500}>
            {status !== 'succeeded' ? `${complete}/${quantity}` : complete}
          </Text>
          {progress && status === 'processing' && (
            <Progress.Root
              w={40}
              h={10}
              className="ml-1"
              transitionDuration={200}
              styles={{
                root: {
                  opacity: 0.5,
                },
              }}
            >
              {[
                { value: (complete / quantity) * 100, color: 'green' },
                { value: (processing / quantity) * 100, color: 'yellow' },
              ].map((section, index) => (
                <Progress.Section
                  key={index}
                  animated
                  value={section.value}
                  color={section.color}
                />
              ))}
            </Progress.Root>
          )}
        </div>
      </Badge>
    </Tooltip>
  );
}
