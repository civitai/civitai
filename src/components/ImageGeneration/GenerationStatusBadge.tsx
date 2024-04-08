import { Badge, BadgeProps, Text, Tooltip } from '@mantine/core';
import { IconLoader, IconPhoto } from '@tabler/icons-react';
import { GenerationRequestStatus } from '~/server/common/enums';
import { generationStatusColors } from '~/shared/constants/generation.constants';

export function GenerationStatusBadge({
  status,
  count,
  quantity,
  tooltipLabel,
  ...badgeProps
}: {
  status: GenerationRequestStatus;
  count: number;
  quantity: number;
  tooltipLabel?: string;
} & BadgeProps) {
  return (
    <Tooltip label={tooltipLabel} withArrow color="dark" maw={300} multiline>
      <Badge
        variant="light"
        size="sm"
        color={generationStatusColors[status]}
        radius="lg"
        h={22}
        {...badgeProps}
      >
        <div className="flex items-center gap-1">
          <IconPhoto size={16} />
          <Text size="sm" inline weight={500}>
            {status !== GenerationRequestStatus.Succeeded ? `${count}/${quantity}` : count}
          </Text>
          {status === GenerationRequestStatus.Processing && <IconLoader size={16} />}
        </div>
      </Badge>
    </Tooltip>
  );
}
