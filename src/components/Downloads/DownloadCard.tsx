import { ActionIcon, Badge, Group, Paper, Skeleton, Text, Tooltip } from '@mantine/core';
import {
  IconBox,
  IconClock,
  IconCpu,
  IconFileCode,
  IconPhoto,
  IconTag,
  IconTrash,
} from '@tabler/icons-react';
import dayjs from '~/shared/utils/dayjs';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { useInView } from '~/hooks/useInView';
import type { DownloadHistoryItem } from '~/server/services/download.service';

type Props = {
  download: DownloadHistoryItem;
  onHide: (download: DownloadHistoryItem) => void;
};

// Color mapping for model types
const modelTypeColors: Record<string, string> = {
  Checkpoint: 'blue',
  TextualInversion: 'yellow',
  Hypernetwork: 'cyan',
  AestheticGradient: 'grape',
  LORA: 'violet',
  LoCon: 'violet',
  DoRA: 'orange',
  Controlnet: 'green',
  Upscaler: 'lime',
  VAE: 'teal',
  Poses: 'pink',
  Wildcards: 'gray',
  Workflows: 'indigo',
  MotionModule: 'red',
};

// Color mapping for base models
const baseModelColors: Record<string, string> = {
  'SD 1.5': 'cyan',
  'SD 2.1': 'blue',
  'SDXL 1.0': 'indigo',
  Pony: 'pink',
  Flux: 'rose',
  Other: 'gray',
};

export function DownloadCard({ download, onHide }: Props) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const { modelVersion, file, image, downloadAt } = download;
  const { model } = modelVersion;

  // Format date - relative if < 1 month, absolute otherwise
  const downloadDate = dayjs(downloadAt);
  const isWithinMonth = downloadDate.isAfter(dayjs().subtract(1, 'month'));
  const dateDisplay = isWithinMonth ? downloadDate.fromNow() : downloadDate.format('MMM D, YYYY');

  // Link to specific model version
  const modelUrl = `/models/${model.id}/${slugit(model.name)}?modelVersionId=${modelVersion.id}`;
  const modelTypeColor = modelTypeColors[model.type] ?? 'gray';
  const baseModelColor = baseModelColors[modelVersion.baseModel] ?? 'gray';

  return (
    <div ref={ref} className="h-32">
      {inView ? (
        <Paper
          component={Link}
          href={modelUrl}
          className="overflow-hidden hover:bg-gray-0 dark:hover:bg-dark-5 transition-colors group h-full"
          radius="lg"
          withBorder
        >
          <div className="flex h-full">
            {/* Thumbnail */}
            <div className="w-32 h-32 flex-shrink-0 relative bg-gray-1 dark:bg-dark-6 flex items-center justify-center overflow-hidden">
              {image ? (
                <ImageGuard2 image={image} explain={false}>
                  {(safe) => (
                    <>
                      <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                      {safe ? (
                        <EdgeMedia2
                          metadata={image.metadata}
                          src={image.url}
                          name={image.name}
                          type={image.type}
                          width={128}
                          className="object-cover w-full h-full"
                          loading="lazy"
                        />
                      ) : (
                        <MediaHash hash={image.hash} width={image.width} height={image.height} />
                      )}
                    </>
                  )}
                </ImageGuard2>
              ) : (
                <IconPhoto size={48} className="text-gray-4 dark:text-dark-3" />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 p-4 flex flex-col justify-between min-w-0">
              <div>
                <Text size="sm" fw={600} lineClamp={1}>
                  {model.name}
                </Text>
                <Text size="xs" c="dimmed" lineClamp={1}>
                  {modelVersion.name}
                </Text>

                {/* Badges */}
                <Group gap={6} mt={8} wrap="wrap">
                  {/* Model Type Badge */}
                  <Badge
                    size="md"
                    color={modelTypeColor}
                    variant="light"
                    radius="sm"
                    leftSection={<IconBox size={14} />}
                  >
                    {getDisplayName(model.type)}
                  </Badge>

                  {/* Base Model Badge */}
                  <Badge
                    size="md"
                    color={baseModelColor}
                    variant="light"
                    radius="sm"
                    leftSection={<IconCpu size={14} />}
                  >
                    {modelVersion.baseModel}
                  </Badge>

                  {/* File Type Badge */}
                  {file && (
                    <Badge
                      size="md"
                      color="gray"
                      variant="light"
                      radius="sm"
                      leftSection={<IconTag size={14} />}
                    >
                      {file.type}
                    </Badge>
                  )}

                  {/* Format Badge (always last) */}
                  {file?.format && (
                    <Badge
                      size="md"
                      color="gray"
                      variant="light"
                      radius="sm"
                      leftSection={<IconFileCode size={14} />}
                    >
                      {file.format}
                    </Badge>
                  )}
                </Group>
              </div>

              {/* Date */}
              <Group gap={4} mt={8}>
                <IconClock size={12} className="text-gray-5 dark:text-dark-3" />
                <Tooltip
                  label={downloadDate.format('MMMM D, YYYY h:mm A')}
                  color="dark"
                  withArrow
                  withinPortal
                >
                  <Text size="xs" c="dimmed">
                    {dateDisplay}
                  </Text>
                </Tooltip>
              </Group>
            </div>

            {/* Delete Button - vertically centered */}
            <div className="flex items-center pr-4">
              <Tooltip label="Remove from history" color="dark" withArrow withinPortal>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="md"
                  className="hover:text-red-6 hover:bg-red-1 dark:hover:bg-red-9/20"
                  onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onHide(download);
                  }}
                >
                  <IconTrash size={18} />
                </ActionIcon>
              </Tooltip>
            </div>
          </div>
        </Paper>
      ) : (
        <Skeleton height={128} radius="lg" />
      )}
    </div>
  );
}
