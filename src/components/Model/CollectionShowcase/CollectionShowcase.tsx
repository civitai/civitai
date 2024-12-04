import { ActionIcon, Badge, Group, Loader, LoadingOverlay, ScrollArea, Text } from '@mantine/core';
import {
  IconBookmark,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconMessageCircle2,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRouter } from 'next/router';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useModelShowcaseCollection, UseQueryModelReturn } from '~/components/Model/model.utils';
import { ModelTypeBadge } from '~/components/Model/ModelTypeBadge/ModelTypeBadge';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit } from '~/utils/string-helpers';

export function CollectionShowcase({ modelId, loading }: Props) {
  const {
    items = [],
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetching,
    isRefetching,
  } = useModelShowcaseCollection({ modelId });

  return (
    <div className="relative">
      <LoadingOverlay visible={isRefetching} zIndex={9} />
      <ScrollArea.Autosize maxHeight={300}>
        {isLoading || loading ? (
          <div className="flex items-center justify-center p-2">
            <Loader variant="bars" size="sm" />
          </div>
        ) : items.length > 0 ? (
          <>
            {items.map((model) => (
              <ShowcaseItem key={model.id} {...model} />
            ))}
            {hasNextPage && (
              <InViewLoader
                loadFn={fetchNextPage}
                loadCondition={!isFetching}
                style={{ gridColumn: '1/-1' }}
              >
                <div className="flex items-center justify-center px-4 py-2">
                  <Loader variant="bars" size="sm" />
                </div>
              </InViewLoader>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center p-2">
            <Text color="dimmed">There are no items for this collection</Text>
          </div>
        )}
      </ScrollArea.Autosize>
    </div>
  );
}

type Props = { modelId: number; loading?: boolean };

function ShowcaseItem({ id, name, images, rank, type, version }: ShowcaseItemProps) {
  const router = useRouter();
  const [image] = images;

  const activeItem = router.query.id === id.toString();

  return (
    <Link href={`/models/${id}/${slugit(name)}`} passHref>
      <a
        className={clsx(
          'flex items-center gap-4 px-3 py-2 no-underline',
          'hover:bg-gray-1 dark:hover:bg-dark-5',
          activeItem && 'bg-gray-1 dark:bg-dark-5'
        )}
      >
        <ImageGuard2 image={image} explain={false}>
          {(safe) => (
            <div className="relative size-16 shrink-0 grow-0 overflow-hidden rounded-lg bg-gray-2 dark:bg-dark-3">
              {!safe ? (
                <div className="flex size-full items-center justify-center">
                  <ImageGuard2.BlurToggle>
                    {(toggle) => (
                      <ActionIcon
                        color="red"
                        radius="xl"
                        sx={(theme) => ({
                          backgroundColor: theme.fn.rgba(theme.colors.red[9], 0.6),
                          color: 'white',
                          backdropFilter: 'blur(7px)',
                          boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
                          zIndex: 10,
                        })}
                        onClick={toggle}
                      >
                        {safe ? (
                          <IconEyeOff size={14} strokeWidth={2.5} />
                        ) : (
                          <IconEye size={14} strokeWidth={2.5} />
                        )}
                      </ActionIcon>
                    )}
                  </ImageGuard2.BlurToggle>
                  <MediaHash {...image} />
                </div>
              ) : (
                <EdgeMedia
                  src={image.url}
                  width={450}
                  name={image.name ?? image.id.toString()}
                  type={image.type}
                  loading="lazy"
                  wrapperProps={{ style: { width: '100%', height: '100%' } }}
                  contain
                  style={{
                    objectFit: 'cover',
                    minHeight: '100%',
                  }}
                />
              )}
            </div>
          )}
        </ImageGuard2>
        <div className="flex flex-auto flex-col gap-2">
          <div>
            <Text size="sm" weight={500} lineClamp={1}>
              {name}
            </Text>
            <Text size="xs" color="dimmed" weight={500} lineClamp={1}>
              {version.name}
            </Text>
          </div>
          {rank && (
            <Group align="center" position="apart" spacing={4}>
              <ModelTypeBadge
                classNames={{ inner: 'flex gap-2 flex-nowrap' }}
                type={type}
                baseModel={version.baseModel}
              />
              <Badge
                variant="light"
                color="gray"
                radius="xl"
                classNames={{ inner: 'flex gap-2 flex-nowrap' }}
              >
                <Group spacing={2}>
                  <IconDownload size={14} strokeWidth={2.5} />
                  <Text size="xs">{abbreviateNumber(rank?.downloadCount ?? 0)}</Text>
                </Group>
                <Group spacing={2}>
                  <IconBookmark size={14} strokeWidth={2.5} />
                  <Text size="xs">{abbreviateNumber(rank?.collectedCount ?? 0)}</Text>
                </Group>
                <Group spacing={2}>
                  <IconMessageCircle2 size={14} strokeWidth={2.5} />
                  <Text size="xs">{abbreviateNumber(rank?.commentCount ?? 0)}</Text>
                </Group>
              </Badge>
            </Group>
          )}
        </div>
      </a>
    </Link>
  );
}

type ShowcaseItemProps = UseQueryModelReturn[number];
