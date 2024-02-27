import {
  createStyles,
  UnstyledButton,
  Center,
  Button,
  Group,
  ActionIcon,
  Text,
  Stack,
  Badge,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { CollectionType } from '@prisma/client';
import { IconBrush, IconEye, IconInfoCircle, IconShare3, IconX } from '@tabler/icons-react';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { truncate } from 'lodash-es';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { Reactions } from '~/components/Reaction/Reactions';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { constants } from '~/server/common/constants';
import { generationPanel } from '~/store/generation.store';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';

type GalleryCarouselProps = {
  className?: string;
};

/**NOTES**
  - when our current image is not found in the images array, we can navigate away from it, but we can't use the arrows to navigate back to it.
*/
const maxIndicators = 20;
export function ImageDetailCarousel({ className }: GalleryCarouselProps) {
  const { classes, cx, theme } = useStyles();
  const {
    images,
    image: image,
    next,
    previous,
    navigate,
    canNavigate,
    connect,
    close,
    shareUrl,
    toggleInfo,
  } = useImageDetailContext();

  const { setRef, height, width } = useAspectRatioFit({
    height: image?.height ?? 1200,
    width: image?.width ?? 1200,
  });

  // #region [navigation]
  useHotkeys([
    ['ArrowLeft', previous],
    ['ArrowRight', next],
  ]);
  // #endregion

  if (!image) return null;

  const indicators = images.map(({ id }) => (
    <UnstyledButton
      key={id}
      data-active={image.id === id || undefined}
      className={classes.indicator}
      aria-hidden
      tabIndex={-1}
      onClick={() => navigate(id)}
    />
  ));

  const hasMultipleImages = images.length > 1;

  return (
    <div ref={setRef} className={cx(classes.root, className)}>
      {canNavigate && (
        <>
          <UnstyledButton className={cx(classes.control, classes.prev)} onClick={previous}>
            <IconChevronLeft />
          </UnstyledButton>
          <UnstyledButton className={cx(classes.control, classes.next)} onClick={next}>
            <IconChevronRight />
          </UnstyledButton>
        </>
      )}
      <ImageGuard2 image={image} {...connect}>
        {(safe) => (
          <>
            <Group
              position="apart"
              spacing="sm"
              px={8}
              style={{ position: 'absolute', top: 15, width: '100%', zIndex: 10 }}
            >
              <Group>
                <ImageGuard2.BlurToggle radius="xl" h={30} size="lg" />
                <Badge
                  radius="xl"
                  size="sm"
                  color="gray.8"
                  px="xs"
                  variant="light"
                  className={classes.actionIcon}
                >
                  <Group spacing={2}>
                    <IconEye size={16} stroke={1.5} color="white" />
                    <Text color="white" size="xs" align="center" weight={500}>
                      {abbreviateNumber(image.stats?.viewCountAllTime ?? 0)}
                    </Text>
                  </Group>
                </Badge>
              </Group>
              <Group spacing="xs">
                {image.meta && (
                  <Button
                    size="md"
                    radius="xl"
                    color="blue"
                    onClick={() => generationPanel.open({ type: 'image', id: image.id })}
                    data-activity="remix:image"
                    compact
                    variant="default"
                    className={cx(classes.generateButton)}
                  >
                    <Group spacing={4} noWrap>
                      <IconBrush size={16} />
                      <Text size="xs">Remix</Text>
                    </Group>
                  </Button>
                )}
                <ShareButton
                  url={shareUrl}
                  title={`Image by ${image.user.username}`}
                  collect={{ type: CollectionType.Image, imageId: image.id }}
                >
                  <ActionIcon
                    size={30}
                    radius="xl"
                    color="gray"
                    variant="light"
                    className={classes.actionIcon}
                  >
                    <IconShare3 size={16} color="white" />
                  </ActionIcon>
                </ShareButton>
                <ImageContextMenu
                  {...image}
                  radius="xl"
                  color="gray"
                  variant="light"
                  style={{
                    color: 'white',
                    backdropFilter: 'blur(7px)',
                    background: theme.fn.rgba(theme.colors.gray[8], 0.4),
                  }}
                  iconSize={16}
                />
                <ActionIcon
                  size={30}
                  radius="xl"
                  color="gray.8"
                  variant="light"
                  className={classes.actionIcon}
                  onClick={close}
                >
                  <IconX size={16} color="white" />
                </ActionIcon>
              </Group>
            </Group>
            <Stack
              px={8}
              style={{
                position: 'absolute',
                bottom: hasMultipleImages ? theme.spacing.xl + 12 : 15,
                width: '100%',
                zIndex: 10,
              }}
            >
              <Group spacing={4} noWrap position="apart">
                <Reactions
                  entityId={image.id}
                  entityType="image"
                  reactions={image.reactions}
                  metrics={{
                    likeCount: image.stats?.likeCountAllTime,
                    dislikeCount: image.stats?.dislikeCountAllTime,
                    heartCount: image.stats?.heartCountAllTime,
                    laughCount: image.stats?.laughCountAllTime,
                    cryCount: image.stats?.cryCountAllTime,
                    tippedAmountCount: image.stats?.tippedAmountCountAllTime,
                  }}
                  targetUserId={image.user.id}
                />

                <ActionIcon
                  size={30}
                  onClick={toggleInfo}
                  radius="xl"
                  color="gray.8"
                  variant="light"
                  className={classes.actionIcon}
                >
                  <IconInfoCircle size={16} color="white" />
                </ActionIcon>
              </Group>
            </Stack>
            <Center
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
              }}
            >
              <Center
                style={{
                  position: 'relative',
                  height: height,
                  width: width,
                }}
              >
                {!safe ? (
                  <MediaHash {...image} />
                ) : (
                  <EdgeMedia
                    src={image.url}
                    name={image.name ?? image.id.toString()}
                    alt={
                      image.meta
                        ? truncate(image.meta.prompt, { length: constants.altTruncateLength })
                        : image.name ?? undefined
                    }
                    type={image.type}
                    style={{ maxHeight: '100%', maxWidth: '100%' }}
                    width="original"
                    anim
                    controls
                    fadeIn
                  />
                )}
              </Center>
            </Center>
          </>
        )}
      </ImageGuard2>

      {images.length <= maxIndicators && hasMultipleImages && (
        <div className={classes.indicators}>{indicators}</div>
      )}
    </div>
  );
}

const useStyles = createStyles((theme, _props, getRef) => {
  const isMobile = containerQuery.smallerThan('md');
  const isDesktop = containerQuery.largerThan('md');

  return {
    mobileOnly: { [isDesktop]: { display: 'none' } },
    desktopOnly: { [isMobile]: { display: 'none' } },
    root: {
      position: 'relative',
    },
    center: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
    },

    prev: { ref: getRef('prev') },
    next: { ref: getRef('next') },
    control: {
      position: 'absolute',
      // top: 0,
      // bottom: 0,
      top: '50%',
      transform: 'translateY(-50%)',
      zIndex: 10,

      svg: {
        height: 50,
        width: 50,
      },

      [`&.${getRef('prev')}`]: {
        left: 0,
      },
      [`&.${getRef('next')}`]: {
        right: 0,
      },

      '&:hover': {
        color: theme.colors.blue[3],
      },
    },
    indicators: {
      position: 'absolute',
      bottom: theme.spacing.md,
      top: undefined,
      left: 0,
      right: 0,
      display: 'flex',
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 8,
      pointerEvents: 'none',
    },

    indicator: {
      pointerEvents: 'all',
      width: 25,
      height: 5,
      borderRadius: 10000,
      backgroundColor: theme.white,
      boxShadow: theme.shadows.sm,
      opacity: 0.6,
      transition: `opacity 150ms ${theme.transitionTimingFunction}`,

      '&[data-active]': {
        opacity: 1,
      },
    },

    generateButton: {
      position: 'relative',

      '&::before': {
        content: '""',
        position: 'absolute',
        left: '-3px',
        top: '-3px',
        background: theme.fn.linearGradient(
          10,
          theme.colors.blue[9],
          theme.colors.blue[7],
          theme.colors.blue[5],
          theme.colors.cyan[9],
          theme.colors.cyan[7],
          theme.colors.cyan[5]
        ),
        backgroundSize: '200%',
        borderRadius: theme.radius.xl,
        width: 'calc(100% + 6px)',
        height: 'calc(100% + 6px)',
        filter: 'blur(4px)',
        zIndex: -1,
        animation: 'glowing 20s linear infinite',
        transition: 'opacity .3s ease-in-out',
      },
    },
    actionIcon: {
      height: 30,
      backdropFilter: 'blur(7px)',
      color: 'white',
      background: theme.fn.rgba(theme.colors.gray[8], 0.4),
    },
  };
});
