import { CopyButton, Tooltip, Badge, Group } from '@mantine/core';
import { IconCopy } from '@tabler/icons';
import { useMemo } from 'react';
import { ModelFileType } from '~/server/common/constants';

export function TrainedWords({ trainedWords = [], files = [] }: Props) {
  const words = useMemo(() => {
    const words = trainedWords;
    const hasNegativeEmbed = files.some((file) => file.type === ('Negative' as ModelFileType));
    const [firstWord] = trainedWords;
    if (firstWord && hasNegativeEmbed) return [firstWord, firstWord + '-neg'];
    return words;
  }, [trainedWords, files]);

  return (
    <Group spacing={4}>
      {words.map((word, index) => (
        <TrainingWordBadge key={index} word={word} />
      ))}
    </Group>
  );
}

type Props = { trainedWords?: string[]; files?: { type: string }[] };

export function TrainingWordBadge({ word }: { word: string }) {
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
