import {
  createStyles,
  UnstyledButton,
  Center,
  Button,
  Group,
  Box,
  CloseButton,
  ActionIcon,
  Text,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { CollectionType } from '@prisma/client';
import { IconBrush, IconShare3 } from '@tabler/icons-react';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { truncate } from 'lodash-es';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { generationPanel } from '~/store/generation.store';
import { containerQuery } from '~/utils/mantine-css-helpers';

type GalleryCarouselProps = {
  className?: string;
};

/**NOTES**
  - when our current image is not found in the images array, we can navigate away from it, but we can't use the arrows to navigate back to it.
*/
const maxIndicators = 20;
export function ImageDetailCarousel({ className }: GalleryCarouselProps) {
  const currentUser = useCurrentUser();
  const { classes, cx, theme } = useStyles();
  const {
    images,
    image: current,
    next,
    previous,
    navigate,
    canNavigate,
    connect,
    close,
    shareUrl,
  } = useImageDetailContext();

  const { setRef, height, width } = useAspectRatioFit({
    height: current?.height ?? 1200,
    width: current?.width ?? 1200,
  });

  // #region [navigation]
  useHotkeys([
    ['ArrowLeft', previous],
    ['ArrowRight', next],
  ]);
  // #endregion

  if (!current) return null;

  const indicators = images.map(({ id }) => (
    <UnstyledButton
      key={id}
      data-active={current.id === id || undefined}
      className={classes.indicator}
      aria-hidden
      tabIndex={-1}
      onClick={() => navigate(id)}
    />
  ));

  const hasMultipleImages = images.length > 1;
  const showGenerateButton = !currentUser && !!current.meta;

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
      <ImageGuard
        images={[current]}
        connect={connect}
        render={(image) => {
          return (
            <>
              <Group
                position="apart"
                spacing="sm"
                px={15}
                style={{ position: 'absolute', top: 15, width: '100%', zIndex: 10 }}
              >
                <Group>Test</Group>
                <Group spacing="xs">
                  <ImageGuard.ToggleConnect
                    position="static"
                    sx={(theme) => ({ height: 30, borderRadius: theme.radius.xl })}
                    size="lg"
                  />
                  <ImageGuard.ToggleImage
                    position="static"
                    sx={(theme) => ({ height: 30, borderRadius: theme.radius.xl })}
                    size="lg"
                  />
                  {currentUser && image.meta && (
                    <Button
                      size="md"
                      radius="xl"
                      color="blue"
                      variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                      onClick={() => generationPanel.open({ type: 'image', id: image.id })}
                      data-activity="remix:image"
                      compact
                    >
                      <Group spacing={4} noWrap>
                        <IconBrush size={14} />
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
                      variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                    >
                      <IconShare3 size={14} />
                    </ActionIcon>
                  </ShareButton>
                  <CloseButton
                    size="lg"
                    variant="default"
                    onClick={close}
                    className={classes.mobileOnly}
                    radius="xl"
                  />
                  <ImageGuard.Report
                    position="static"
                    actionIconProps={{
                      radius: 'xl',
                      color: 'gray',
                      variant: theme.colorScheme === 'dark' ? 'filled' : 'light',
                    }}
                  />
                </Group>
              </Group>
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
                  <ImageGuard.Unsafe>
                    <MediaHash {...image} />
                  </ImageGuard.Unsafe>
                  <ImageGuard.Safe>
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
                    {showGenerateButton && (
                      <Box
                        sx={(theme) => ({
                          position: 'absolute',
                          bottom: hasMultipleImages ? theme.spacing.xl + 8 : theme.spacing.md,
                          left: '50%',
                          transform: 'translate(-50%)',
                        })}
                      >
                        <Button
                          className={classes.generateButton}
                          variant="default"
                          radius="xl"
                          onClick={() => generationPanel.open({ type: 'image', id: image.id })}
                        >
                          <Group spacing={4} noWrap>
                            <IconBrush size={20} /> Create images like this!
                          </Group>
                        </Button>
                      </Box>
                    )}
                  </ImageGuard.Safe>
                </Center>
              </Center>
            </>
          );
        }}
      />
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
  };
});
