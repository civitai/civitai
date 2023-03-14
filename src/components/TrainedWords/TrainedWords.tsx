import { CopyButton, Tooltip, Badge, Group } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconCheck, IconCopy } from '@tabler/icons';
import { useMemo, useState } from 'react';
import { ModelFileType } from '~/server/common/constants';

export function TrainedWords({ trainedWords = [], files = [], type, limit = 10 }: Props) {
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
    <Group spacing={4}>
      {words.map((word, index) => (
        <TrainingWordBadge key={index} word={word} />
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
};

export function TrainingWordBadge({ word }: { word: string }) {
  return (
    <CopyButton value={word}>
      {({ copy, copied }) => (
        <Tooltip label="Copied!" opened={copied}>
          <Badge
            size="sm"
            radius="sm"
            color={copied ? 'green' : 'violet'}
            sx={{ cursor: 'pointer', height: 'auto' }}
            onClick={copy}
            pr={2}
          >
            <Group spacing={5} align="center" noWrap sx={{ whiteSpace: 'normal' }}>
              {word}
              {copied ? <IconCheck stroke={2} size={14} /> : <IconCopy stroke={2} size={14} />}
            </Group>
          </Badge>
        </Tooltip>
      )}
    </CopyButton>
  );
}
