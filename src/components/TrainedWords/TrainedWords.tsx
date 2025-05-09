import { CopyButton, Tooltip, Badge, Group, BadgeProps } from '@mantine/core';
import { ModelType } from '~/shared/utils/prisma/enums';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { ModelFileType } from '~/server/common/constants';

export function TrainedWords({
  trainedWords = [],
  files = [],
  type,
  limit = 10,
  badgeProps,
}: Props) {
  const [showAll, setShowAll] = useState(false);

  const words = useMemo(() => {
    let words = trainedWords;
    const hasNegativeEmbed = files.some((file) => file.type === ('Negative' as ModelFileType));
    const [firstWord] = trainedWords;
    if (firstWord && hasNegativeEmbed) return [firstWord, firstWord + '-neg'];
    if (!showAll && words.length > limit) words = words.slice(0, limit);
    if (type === ModelType.Wildcards) return words.map((word) => `__${word}__`);
    return words;
  }, [trainedWords, files, type, showAll, limit]);

  return (
    <Group gap={4}>
      {words.map((word, index) => (
        <TrainingWordBadge key={index} word={word} {...badgeProps} />
      ))}
      {trainedWords.length > limit && !showAll && (
        <Badge
          size="sm"
          radius="sm"
          color="gray"
          sx={{ cursor: 'pointer' }}
          onClick={() => setShowAll(true)}
        >
          +{trainedWords.length - limit} more
        </Badge>
      )}
    </Group>
  );
}

type Props = {
  trainedWords?: string[];
  files?: { type: string }[];
  type: ModelType;
  limit?: number;
  badgeProps?: BadgeProps;
};

export function TrainingWordBadge({ word, ...badgeProps }: BadgeProps & { word: string }) {
  return (
    <CopyButton value={word.trim()}>
      {({ copy, copied }) => (
        <Tooltip label="Copied!" opened={copied}>
          <Badge
            size="sm"
            radius="sm"
            color={copied ? 'green' : 'violet'}
            sx={{ cursor: 'pointer', height: 'auto' }}
            onClick={copy}
            pr={2}
            {...badgeProps}
          >
            <Group gap={5} align="center" wrap="nowrap" sx={{ whiteSpace: 'normal' }}>
              {word}
              {copied ? (
                <IconCheck className="shrink-0 grow-0" stroke={2} size={14} />
              ) : (
                <IconCopy className="shrink-0 grow-0" stroke={2} size={14} />
              )}
            </Group>
          </Badge>
        </Tooltip>
      )}
    </CopyButton>
  );
}
