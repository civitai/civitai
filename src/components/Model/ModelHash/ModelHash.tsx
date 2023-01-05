import { ActionIcon, Badge, CopyButton, Group, MantineColor, Tooltip } from '@mantine/core';
import { ModelHashType } from '@prisma/client';
import { IconChevronRight } from '@tabler/icons';
import { useState } from 'react';

export const ModelHash = ({ hashes, initialType = 'AutoV1', color = 'gray' }: Props) => {
  const [selected, setSelected] = useState(
    hashes.find((hash) => hash.type === initialType) ?? hashes[0]
  );
  const { hash, type } = selected;
  const hasMore = hashes.length > 1;

  const handleNext = () => setSelected(hashes[(hashes.indexOf(selected) + 1) % hashes.length]);

  return (
    <Group spacing={0} noWrap sx={{ userSelect: 'none' }}>
      <Badge
        variant="outline"
        color={color}
        px={6}
        sx={{ width: 60, borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRight: 0 }}
      >
        {type}
      </Badge>
      <CopyButton value={hash}>
        {({ copied, copy }) => (
          <Tooltip label="Copy" withArrow withinPortal>
            <Badge
              px={6}
              variant="outline"
              color={copied ? 'teal' : color}
              sx={{
                cursor: 'pointer',
                overflow: 'hidden',
                width: 100,
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                borderTopRightRadius: hasMore ? 0 : undefined,
                borderBottomRightRadius: hasMore ? 0 : undefined,
              }}
              onClick={copy}
            >
              {copied ? 'Copied' : hash}
            </Badge>
          </Tooltip>
        )}
      </CopyButton>
      {hasMore && (
        <ActionIcon
          px={2}
          size={20}
          variant="outline"
          color={color}
          sx={{
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
            borderLeft: 0,
            cursor: 'pointer',
          }}
          onClick={handleNext}
        >
          <IconChevronRight />
        </ActionIcon>
      )}
    </Group>
  );
};

type Props = {
  color?: MantineColor;
  initialType?: ModelHashType;
  hashes: {
    type: ModelHashType;
    hash: string;
  }[];
};
