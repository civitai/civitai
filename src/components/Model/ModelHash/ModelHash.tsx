import type { MantineColor } from '@mantine/core';
import { ActionIcon, Badge, CopyButton, Group, Tooltip } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronRight } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { ModelHashType } from '~/shared/utils/prisma/enums';

export const ModelHash = ({
  hashes,
  initialType = 'AutoV2',
  color = 'gray',
  width = 120,
}: Props) => {
  const [preferredType, setPreferredType] = useLocalStorage({
    key: 'preferredModelHashType',
    defaultValue: initialType,
  });
  const [selected, setSelected] = useState(
    hashes.find((hash) => hash.type === preferredType) ?? hashes[0]
  );
  const { hash, type } = selected;
  const hasMore = hashes.length > 1;

  useEffect(() => {
    setSelected(hashes.find((hash) => hash.type === preferredType) ?? hashes[0]);
  }, [preferredType, hashes]);

  const handleNext = () => {
    const next = hashes[(hashes.indexOf(selected) + 1) % hashes.length];
    setPreferredType(next.type);
  };

  return (
    <Group gap={0} wrap="nowrap" style={{ userSelect: 'none' }}>
      <Badge
        variant="outline"
        color={color}
        px={6}
        style={{
          // width: 60,
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
          borderRight: 0,
          whiteSpace: 'nowrap',
        }}
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
              style={{
                cursor: 'pointer',
                overflow: 'hidden',
                width,
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                borderTopRightRadius: hasMore ? 0 : undefined,
                borderBottomRightRadius: hasMore ? 0 : undefined,
              }}
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                copy();
              }}
            >
              {copied ? 'Copied' : hash}
            </Badge>
          </Tooltip>
        )}
      </CopyButton>
      {hasMore && (
        <LegacyActionIcon
          px={2}
          size={20}
          variant="outline"
          color={color}
          style={{
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
            borderLeft: 0,
            cursor: 'pointer',
          }}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            handleNext();
          }}
        >
          <IconChevronRight />
        </LegacyActionIcon>
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
  width?: number;
};
