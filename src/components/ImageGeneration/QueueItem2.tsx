import {
  Accordion,
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  HoverCard,
  Paper,
  Popover,
  Stack,
  Text,
  ThemeIcon,
  Title,
  UnstyledButton,
  createStyles,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { ModelType } from '@prisma/client';
import { IconBolt, IconInfoCircle, IconPhoto, IconX } from '@tabler/icons-react';
import { useCallback } from 'react';

import { Collection } from '~/components/Collection/Collection';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { Countdown } from '~/components/Countdown/Countdown';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useImageGenerationStore } from '~/components/ImageGeneration/hooks/useImageGenerationState';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { Generation } from '~/server/services/generation/generation.types';
import { formatDate } from '~/utils/date-helpers';
import { splitUppercase, titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function QueueItem2({ id }: { id: number }) {
  const { classes, cx } = useStyles();
  const item = useImageGenerationStore(useCallback((state) => state.requests[id], []));
  const removeRequest = useImageGenerationStore((state) => state.removeRequest);
  const deleteMutation = trpc.generation.deleteRequest.useMutation({
    onSuccess: (response, request) => {
      removeRequest(request.id);
    },
  });
  const modelVersion = item.resources.find((x) => x.modelType === ModelType.Checkpoint);

  return (
    <Card>
      <Stack>
        <Stack spacing={0}>
          <Group>
            <Text weight={600}>
              {modelVersion?.modelName} - {modelVersion?.name}
            </Text>
            <ImageMetaPopover meta={item.params}>
              <ActionIcon>
                <IconInfoCircle />
              </ActionIcon>
            </ImageMetaPopover>
          </Group>
          <Group align="center" position="apart">
            <Text size="sm">{formatDate(item.createdAt, 'MMM DD, YYYY')}</Text>
            <Text size="sm">
              ETA: <Countdown endTime={item.estimatedCompletionDate} />
            </Text>
            {/* <Countdown endTime={item.estimatedCompletionDate} /> */}
          </Group>
        </Stack>
        <div className={classes.grid}>
          {item.images?.map((image) => (
            <EdgeImage key={image.id} src={image.url} width={item.params.width} />
          ))}
        </div>
      </Stack>
    </Card>
  );
}

const useStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: theme.spacing.md,
  },
}));
