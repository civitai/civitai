import { CopyButton, Tooltip, Badge, Group } from '@mantine/core';
import { IconCopy } from '@tabler/icons';

export function TrainingWordBadge({ word }: Props) {
  return (
    <CopyButton value={word}>
      {({ copy, copied }) => (
        <Tooltip label="Copied!" opened={copied}>
          <Badge
            size="sm"
            radius="sm"
            color="violet"
            sx={{ cursor: 'pointer', height: 'auto' }}
            onClick={copy}
            rightSection={<IconCopy stroke={1.5} size={12} />}
          >
            <Group spacing={4} align="center" noWrap sx={{ whiteSpace: 'normal' }}>
              {word}
            </Group>
          </Badge>
        </Tooltip>
      )}
    </CopyButton>
  );
}

type Props = { word: string };
