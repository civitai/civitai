import { ActionIcon, AspectRatio, Box, Card, createStyles, Group, Menu, Text } from '@mantine/core';
import { useWindowSize } from '@react-hook/window-size';
import { IconDotsVertical, IconFlag, IconMessageCircle2 } from '@tabler/icons';
import {
  useContainerPosition,
  usePositioner,
  useScroller,
  useResizeObserver,
  useScrollToIndex,
  useMasonry,
} from 'masonic';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useRef, useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useGalleryFilters } from '~/components/Gallery/GalleryFilters';
import { ReportImageButton } from '~/components/Gallery/ReportImageButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { Reactions } from '~/components/Reaction/Reactions';
import { openRoutedContext, RoutedContextLink } from '~/providers/RoutedContextProvider';
import { ImageGetAllInfinite } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';

export function InfiniteGalleryGrid({ columnWidth, data, filters }: Props) {
  const router = useRouter();
  const stringified = JSON.stringify(filters);
  // const modelId = Number(([] as string[]).concat(router.query.model ?? [])[0]);

  const containerRef = useRef(null);
  const [windowWidth, height] = useWindowSize();
  const { offset, width } = useContainerPosition(containerRef, [windowWidth, height]);
  // with 'stringified' in the dependency array, masonic knows to expect layout changes
  const positioner = usePositioner({ width, columnGutter: 16, columnWidth }, [stringified]);
  const { scrollTop, isScrolling } = useScroller(offset);
  const resizeObserver = useResizeObserver(positioner);
  const scrollToIndex = useScrollToIndex(positioner, {
    offset,
    height,
    align: 'center',
  });

  // TODO.gallery - scrollTo entityId
  // useEffect(() => {
  //   if (!data?.length || !modelId) return;
  //   // if (!modelId) scrollToIndex(0);
  //   const index = data.findIndex((x) => x.id === modelId);
  //   if (index === -1 || data.length < index) return;

  //   scrollToIndex(index);
  // }, [stringified]); //eslint-disable-line

  return useMasonry({
    resizeObserver,
    positioner,
    scrollTop,
    isScrolling,
    height,
    containerRef,
    items: data,
    overscanBy: 10,
    render: MasonryItem,
  });
}

type Props = {
  columnWidth: number;
  data: ImageGetAllInfinite;
  filters: ReturnType<typeof useGalleryFilters>['filters'];
};

const useStyles = createStyles((theme) => {
  const base = theme.fn.primaryColor();
  const background = theme.colorScheme === 'dark' ? theme.colors.dark[6] : '#fff';

  return {
    card: {
      height: '300px',
      cursor: 'pointer',
      background: theme.fn.gradient({
        from: base,
        to: background,
        deg: 180,
      }),
    },

    content: {
      background: theme.fn.gradient({
        from: 'rgba(37,38,43,0.8)',
        to: 'rgba(37,38,43,0)',
        deg: 0,
      }),
      backdropFilter: 'blur(13px) saturate(160%)',
      boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    },

    info: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      left: 0,
      zIndex: 10,
    },

    statBadge: {
      background: 'rgba(212,212,212,0.2)',
      color: 'white',
    },
  };
});

function MasonryItem({ data: image, width: itemWidth }: MasonryItemProps) {
  const { classes, cx } = useStyles();
  const { ref, inView } = useInView();

  const height = useMemo(() => {
    if (!image.width || !image.height) return 300;
    const width = itemWidth > 0 ? itemWidth : 300;
    const aspectRatio = image.width / image.height;
    const imageHeight = Math.floor(width / aspectRatio);
    return Math.min(imageHeight, 600);
  }, [itemWidth, image.width, image.height]);

  return (
    <RoutedContextLink modal="galleryDetailModal" galleryImageId={image.id}>
      <Card
        ref={ref}
        className={classes.card}
        component="a"
        shadow="sm"
        p={0}
        sx={{ height: `${height}px` }}
        withBorder
      >
        {inView && (
          <>
            <ImageGuard
              images={[image]}
              // connect={{ entityId: image.id, entityType: 'model' }}
              render={(image) => (
                <Box sx={{ position: 'relative' }}>
                  <Menu position="left">
                    <Menu.Target>
                      <ActionIcon
                        variant="transparent"
                        p={0}
                        onClick={(e: React.MouseEvent) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        sx={{
                          width: 30,
                          position: 'absolute',
                          top: 10,
                          right: 4,
                          zIndex: 8,
                        }}
                      >
                        <IconDotsVertical
                          size={24}
                          color="#fff"
                          style={{ filter: `drop-shadow(0 0 2px #000)` }}
                        />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <ReportImageButton imageId={image.id}>
                        <Menu.Item icon={<IconFlag size={14} stroke={1.5} />}>Report</Menu.Item>
                      </ReportImageButton>
                    </Menu.Dropdown>
                  </Menu>
                  <ImageGuard.ToggleImage
                    sx={(theme) => ({
                      backgroundColor: theme.fn.rgba(theme.colors.red[9], 0.4),
                      color: 'white',
                      backdropFilter: 'blur(7px)',
                      boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
                      position: 'absolute',
                      top: theme.spacing.xs,
                      left: theme.spacing.xs,
                      zIndex: 10,
                    })}
                    position="static"
                  />
                  {/* <ImageGuard.ToggleConnect /> */}
                  <ImageGuard.Unsafe>
                    <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                      <MediaHash {...image} />
                    </AspectRatio>
                  </ImageGuard.Unsafe>
                  <ImageGuard.Safe>
                    <EdgeImage
                      src={image.url}
                      name={image.name ?? image.id.toString()}
                      alt={image.name ?? undefined}
                      width={450}
                      placeholder="empty"
                      style={{ width: '100%', zIndex: 2, position: 'relative' }}
                    />
                  </ImageGuard.Safe>
                </Box>
              )}
            />
            <Group className={cx(classes.info, classes.content)} p="xs" position="apart" noWrap>
              {/* TODO.gallery: Display reaction counts instead */}
              <Reactions
                entityId={image.id}
                entityType="image"
                reactions={image.reactions}
                metrics={image.metrics}
              />
              {/* TODO.gallery: Adjust background and icon/text size */}
              <IconBadge
                color="blue"
                radius="xl"
                variant="light"
                icon={<IconMessageCircle2 size={14} />}
              >
                <Text size="xs">{abbreviateNumber(image.metrics?.commentCount ?? 0)}</Text>
              </IconBadge>
            </Group>
          </>
        )}
      </Card>
    </RoutedContextLink>
  );
}

type MasonryItemProps = {
  data: Props['data'][number];
  index: number;
  width: number;
};
