import { ActionIcon, Badge, CopyButton, Group, MantineColor, Tooltip } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronRight } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { ModelHashType } from '~/shared/utils/prisma/enums';
import styles from './ModelHash.module.scss';

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
    <Group spacing={0} noWrap className={styles.hashContainer}>
      <Badge variant="outline" color={color} className={styles.typeBadge}>
        {type}
      </Badge>
      <CopyButton value={hash}>
        {({ copied, copy }) => (
          <Tooltip label="Copy" withArrow withinPortal>
            <Badge
              variant="outline"
              color={copied ? 'teal' : color}
              className={`${styles.hashBadge} ${copied ? styles.hashBadgeCopied : ''}`}
              style={{ width }}
              onClick={(e) => {
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
        <ActionIcon
          variant="outline"
          color={color}
          className={styles.typeSelector}
          onClick={(e) => {
            e.stopPropagation();
            handleNext();
          }}
        >
          <IconChevronRight size={14} />
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
  width?: number;
};

