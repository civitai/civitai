import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  AspectRatio,
  Box,
  Button,
  Center,
  createStyles,
  Group,
  Indicator,
  Loader,
  Paper,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconInfoCircle, IconPhotoOff } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';

import { useQueryImages } from '~/components/Image/image.utils';
import { ImageGuard, ImageGuardConnect } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { Reactions } from '~/components/Reaction/Reactions';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { ImageSort } from '~/server/common/enums';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { NsfwLevel } from '@prisma/client';
import { SimpleUser } from '~/server/selectors/user.selector';

type ImageProps = {
  id: number;
  nsfw: NsfwLevel;
  imageNsfw?: boolean;
  postId?: number | null;
  width?: number | null;
  height?: number | null;
  needsReview?: string | null;
  userId?: number;
  user?: SimpleUser;
  url?: string | null;
  name?: string | null;
};

const useStyles = createStyles((theme) => ({
  control: {
    svg: {
      width: 24,
      height: 24,

      [theme.fn.smallerThan('sm')]: {
        minWidth: 16,
        minHeight: 16,
      },
    },
  },
  carousel: {
    display: 'block',
    [theme.fn.smallerThan('md')]: {
      display: 'none',
    },
  },
  mobileBlock: {
    display: 'block',
    [theme.fn.largerThan('md')]: {
      display: 'none',
    },
  },
  footer: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    background: theme.fn.gradient({
      from: 'rgba(37,38,43,0.8)',
      to: 'rgba(37,38,43,0)',
      deg: 0,
    }),
    backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    zIndex: 10,
    gap: 6,
    padding: theme.spacing.xs,
  },
  reactions: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    borderRadius: theme.radius.sm,
    background: theme.fn.rgba(
      theme.colorScheme === 'dark' ? theme.colors.dark[9] : theme.colors.gray[0],
      0.8
    ),
    backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    padding: 4,
  },
  info: {
    position: 'absolute',
    bottom: 5,
    right: 5,
  },
  viewport: {
    overflowX: 'clip',
    overflowY: 'visible',
  },
}));

export function ImageCarousel({ images, entityId, entityType, nsfw, mobile = false }: Props) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();

  if (!images.length) {
    return (
      <Paper
        p="sm"
        radius="md"
        className={cx(!mobile && classes.carousel, mobile && classes.mobileBlock)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: mobile ? 300 : 500,
        }}
        withBorder
      >
        <Stack align="center" maw={380}>
          <Stack spacing={4} align="center">
            <ThemeIcon color="gray" size={64} radius={100}>
              <IconPhotoOff size={32} />
            </ThemeIcon>
            <Text size="lg">No showcase images available</Text>
          </Stack>
          <Group grow w="100%">
            {currentUser ? (
              <Button
                component={NextLink}
                href="/user/account#content-moderation"
                variant="outline"
              >
                Adjust Settings
              </Button>
            ) : (
              <Button
                component={NextLink}
                href={`/login?returnUrl=${router.asPath}`}
                variant="outline"
              >
                Log In
              </Button>
            )}
          </Group>
        </Stack>
      </Paper>
    );
  }

  return (
    <Carousel
      key={entityId}
      className={cx(!mobile && classes.carousel, mobile && classes.mobileBlock)}
      classNames={classes}
      slideSize="50%"
      breakpoints={[{ maxWidth: 'sm', slideSize: '100%', slideGap: 2 }]}
      slideGap="xl"
      align={images.length > 2 ? 'start' : 'center'}
      slidesToScroll={mobile ? 1 : 2}
      withControls={images.length > 2 ? true : false}
      controlSize={mobile ? 32 : 56}
      loop
    >
      <ImageGuard
        images={images}
        nsfw={nsfw}
        connect={{ entityId, entityType }}
        render={(image) => {
          return (
            <Carousel.Slide>
              <ImageGuard.Content>
                {({ safe }) => (
                  <Center style={{ height: '100%', width: '100%' }}>
                    <div style={{ width: '100%', position: 'relative' }}>
                      <ImageGuard.ToggleConnect position="top-left" />
                      <ImageGuard.Report />
                      {!safe ? (
                        <AspectRatio
                          ratio={1}
                          sx={(theme) => ({
                            width: '100%',
                            borderRadius: theme.radius.md,
                            overflow: 'hidden',
                          })}
                        >
                          <MediaHash {...image} />
                        </AspectRatio>
                      ) : (
                        <ImagePreview
                          image={image}
                          edgeImageProps={{ width: 450 }}
                          radius="md"
                          style={{ width: '100%' }}
                          aspectRatio={1}
                        />
                      )}
                    </div>
                  </Center>
                )}
              </ImageGuard.Content>
            </Carousel.Slide>
          );
        }}
      />
    </Carousel>
  );
}

type Props = {
  images: ImageProps[];
  nsfw: boolean;
  mobile?: boolean;
} & ImageGuardConnect;
