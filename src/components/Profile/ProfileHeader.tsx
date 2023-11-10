import {
  ActionIcon,
  Alert,
  AspectRatio,
  Button,
  createStyles,
  Divider,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconBellFilled,
  IconMapPin,
  IconPencilMinus,
  IconRss,
} from '@tabler/icons-react';

import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { sortDomainLinks } from '~/utils/domain-link';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { UserStats } from '~/components/Profile/UserStats';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { formatDate } from '~/utils/date-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import React, { useMemo, useState } from 'react';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { openUserProfileEditModal } from '~/components/Modals/UserProfileEditModal';
import { CosmeticType } from '@prisma/client';
import { useIsMobile } from '~/hooks/useIsMobile';
import { constants } from '~/server/common/constants';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import ReactMarkdown from 'react-markdown';
import { ProfileNavigation } from '~/components/Profile/ProfileNavigation';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { isDefined } from '~/utils/type-guards';

const useStyles = createStyles((theme) => ({
  message: {
    [theme.fn.smallerThan('sm')]: {
      borderRadius: 0,
      width: 'auto',
      marginLeft: '-16px',
      marginRight: '-16px',
      paddingTop: 2,
      paddingBottom: 2,
    },
  },
  coverImageNSFWActions: {
    maxHeight: '30vh',
    height: '100%',
    width: '100%',
  },
  coverImageWrapper: {
    maxHeight: '30vh',
    overflow: 'hidden',
    borderRadius: theme.radius.md,
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',

    [theme.fn.smallerThan('sm')]: {
      width: 'auto',
      marginLeft: '-16px',
      marginRight: '-16px',
      maxHeight: 'auto',
      borderRadius: 0,
      display: 'block',
    },
  },
  coverImage: {
    position: 'relative',
    width: '100%',
    overflow: 'hidden',
    height: 0,
    paddingBottom: `${(constants.profile.coverImageAspectRatio * 100).toFixed(3)}%`,

    [theme.fn.smallerThan('sm')]: {
      width: 'auto',
      borderRadius: 0,
      paddingBottom: `${(constants.profile.mobileCoverImageAspectRatio * 100).toFixed(3)}%`,

      div: {
        borderRadius: 0,
      },
    },

    '& > div': {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
    },
  },
  profileSection: {
    width: 'auto',
    marginLeft: '-16px',
    marginRight: '-16px',
    padding: '16px',
    position: 'relative',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
  },
  profileSectionWithCoverImage: {
    padding: '0 16px',

    '& > div': {
      position: 'relative',
      height: 'auto',
      top: '-36px', // Half the avatar size.
      marginBottom: '-18px', // half of top.
    },
  },
}));

export function ProfileHeader({ username }: { username: string }) {
  const { data: user } = trpc.userProfile.get.useQuery({
    username,
  });
  const isMobile = useIsMobile();
  const { classes, cx } = useStyles();
  const {
    images: hiddenImages,
    tags: hiddenTags,
    isLoading: isLoadingHidden,
  } = useHiddenPreferencesContext();
  const currentUser = useCurrentUser();

  const coverImage = useMemo(() => {
    if (isLoadingHidden || !user?.profile?.coverImage) return null;
    const coverImage = user.profile.coverImage;

    if (user.id === currentUser?.id) return coverImage;

    if (hiddenImages.get(coverImage.id)) return null;
    for (const tag of coverImage.tags ?? []) {
      if (hiddenTags.get(tag.id)) return null;
    }
    return coverImage;
  }, [user, hiddenImages, hiddenTags, isLoadingHidden]);

  if (!user) {
    return null;
  }

  const { profile, stats } = user;

  const renderCoverImage = () => {
    if (!coverImage) {
      return null;
    }

    return (
      <div className={classes.coverImageWrapper}>
        <div className={classes.coverImage}>
          <ImageGuard
            images={[coverImage]}
            connect={{ entityId: coverImage.id, entityType: 'user' }}
            render={(image) => {
              return (
                <ImageGuard.Content>
                  {({ safe }) => (
                    <>
                      {!safe ? (
                        <MediaHash {...image} style={{ width: '100%', height: '100%' }} />
                      ) : (
                        <ImagePreview
                          image={image}
                          edgeImageProps={{ width: 1200 }}
                          radius="md"
                          style={{ width: '100%' }}
                        />
                      )}
                      <div className={classes.coverImageNSFWActions}>
                        <ImageGuard.ToggleConnect position="top-left" />
                        <ImageGuard.Report />
                      </div>
                    </>
                  )}
                </ImageGuard.Content>
              );
            }}
          />
        </div>
      </div>
    );
  };

  const renderMessage = () => {
    if (!profile.message) {
      return;
    }

    return (
      <Alert px="xs" className={classes.message}>
        <Group spacing="xs" noWrap>
          <ThemeIcon
            size={32}
            // @ts-ignore: transparent variant does work
            variant="transparent"
            p={0}
          >
            <IconBellFilled />
          </ThemeIcon>
          <Stack spacing={0}>
            <Text>
              <ReactMarkdown
                rehypePlugins={[rehypeRaw, remarkGfm]}
                allowedElements={['a', 'p']}
                unwrapDisallowed
                className="markdown-content"
              >
                {profile.message}
              </ReactMarkdown>
            </Text>
            {profile.messageAddedAt && (
              <Text color="dimmed" size="xs">
                <DaysFromNow date={profile.messageAddedAt} />
              </Text>
            )}
          </Stack>
        </Group>
      </Alert>
    );
  };

  if (isMobile) {
    return (
      <Stack spacing={0}>
        <ProfileNavigation username={username} />
        {renderMessage()}
        {renderCoverImage()}
        <div
          className={cx(classes.profileSection, {
            [classes.profileSectionWithCoverImage]: !!coverImage,
          })}
        >
          <ProfileSidebar username={username} />
        </div>
      </Stack>
    );
  }

  return (
    <Stack>
      <ProfileNavigation username={username} />
      {renderCoverImage()}
      {renderMessage()}
    </Stack>
  );
}
