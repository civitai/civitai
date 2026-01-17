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
import { getBaseModelColor, getModelTypeColor } from '~/shared/constants/badge-color.constants';
import type { DownloadHistoryItem } from '~/server/services/download.service';

type Props = {
  download: DownloadHistoryItem;
  onHide: (download: DownloadHistoryItem) => void;
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
  const modelTypeColor = getModelTypeColor(model.type);
  const baseModelColor = getBaseModelColor(modelVersion.baseModel);

  return (
    <div ref={ref} className="h-32">
      {inView ? (
        <Paper
          component={Link}
          href={modelUrl}
          className="group h-full overflow-hidden transition-colors hover:bg-gray-0 dark:hover:bg-dark-5"
          radius="lg"
          withBorder
        >
          <div className="flex h-full">
            {/* Thumbnail */}
            <div className="relative flex size-32 shrink-0 items-center justify-center overflow-hidden bg-gray-1 dark:bg-dark-6">
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
                          className="size-full object-cover"
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
            <div className="flex min-w-0 flex-1 flex-col justify-between p-4">
              <div>
                <Text size="sm" fw={600} lineClamp={1}>
                  {model.name}
                </Text>
                <Text size="xs" c="dimmed" lineClamp={1}>
                  {modelVersion.name}
                </Text>

                {/* Badges - no wrap, fade out on overflow (mobile only) */}
                <div className="relative mt-2 cursor-pointer">
                  <div
                    className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-r from-transparent
                      to-white group-hover:to-gray-0 md:hidden dark:to-dark-7
                      dark:group-hover:to-dark-5"
                  />
                  <Group gap={6} wrap="nowrap" className="overflow-hidden">
                    {/* Model Type Badge */}
                    <Badge
                      size="md"
                      color={modelTypeColor}
                      variant="light"
                      radius="sm"
                      leftSection={<IconBox size={14} />}
                      className="cursor-pointer"
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
                      className="cursor-pointer"
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
                        className="cursor-pointer"
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
                        className="cursor-pointer"
                      >
                        {file.format}
                      </Badge>
                    )}
                  </Group>
                </div>
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
                  className="hover:bg-red-1 hover:text-red-6 dark:hover:bg-red-9/20"
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
