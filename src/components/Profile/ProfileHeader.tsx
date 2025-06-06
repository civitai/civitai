import { Alert, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconBellFilled } from '@tabler/icons-react';

import { trpc } from '~/utils/trpc';
import React, { useMemo } from 'react';

import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import classes from './ProfileHeader.module.scss';
import clsx from 'clsx';

export function ProfileHeader({ username }: { username: string }) {
  const { data: user } = trpc.userProfile.get.useQuery({
    username,
  });
  const isMobile = useContainerSmallerThan('sm');

  const cover = user?.profile?.coverImage;
  const images = useMemo(
    () =>
      cover
        ? [cover].map((image) => ({ ...image, tagIds: image.tags.map((x) => x.id) }))
        : undefined,
    [cover]
  );
  const { items } = useApplyHiddenPreferences({
    type: 'images',
    data: images,
    allowLowerLevels: true,
  });
  const image = items[0];

  if (!user) {
    return null;
  }

  const { profile } = user;

  const renderCoverImage = () => {
    if (!image) {
      return null;
    }

    return (
      <div className={classes.coverImageWrapper}>
        <div className={classes.coverImage}>
          <ImageGuard2 image={image}>
            {(safe) => (
              <>
                {!safe ? (
                  <MediaHash {...image} style={{ width: '100%', height: '100%' }} />
                ) : (
                  <EdgeMedia
                    src={image.url}
                    name={image.name ?? image.id.toString()}
                    alt={image.name ?? undefined}
                    type={image.type}
                    width={Math.min(image.width ?? 1920, 1920)}
                    style={{ maxWidth: '100%' }}
                    className="w-full max-w-full absolute-center"
                  />
                )}
                <div className={classes.coverImageNsfwActions}>
                  <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                  <ImageContextMenu image={image} className="absolute right-2 top-2 z-10" />
                </div>
              </>
            )}
          </ImageGuard2>
        </div>
      </div>
    );
  };

  const renderMessage = () => {
    if (!profile.message || user.muted) {
      return;
    }

    return (
      <Alert px="xs" className={classes.message}>
        <Group gap="xs" wrap="nowrap">
          <ThemeIcon size={32} variant="transparent" p={0}>
            <IconBellFilled />
          </ThemeIcon>
          <Stack gap={0}>
            <Text>
              <CustomMarkdown
                rehypePlugins={[rehypeRaw, remarkGfm]}
                allowedElements={['a', 'p']}
                unwrapDisallowed
              >
                {profile.message}
              </CustomMarkdown>
            </Text>
            {profile.messageAddedAt && (
              <Text c="dimmed" size="xs">
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
      <div className="flex flex-col gap-3">
        {renderMessage()}
        <div className="flex flex-col">
          {renderCoverImage()}
          <div
            className={clsx(classes.profileSection, {
              [classes.profileSectionWithCoverImage]: !!image,
            })}
          >
            <ProfileSidebar username={username} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <Stack>
      {renderCoverImage()}
      {renderMessage()}
    </Stack>
  );
}
