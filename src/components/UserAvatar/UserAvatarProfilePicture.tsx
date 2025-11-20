import { Center, rgba, useMantineTheme } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ProfileImage } from '~/server/selectors/image.selector';

export function UserAvatarProfilePicture({
  id,
  image,
  username,
  width = 96,
}: {
  id: number;
  image: ProfileImage;
  username?: string | null;
  width?: number;
}) {
  const theme = useMantineTheme();
  const currentUser = useCurrentUser();
  const isSelf = currentUser?.id === id;

  return (
    <ImageGuard2 image={image} explain={false}>
      {(safe) => (
        <>
          {!isSelf && !safe ? (
            <Center h="100%" className="relative">
              {/* TODO: this nests a button inside a button */}
              <ImageGuard2.BlurToggle>
                {(toggle) => (
                  <LegacyActionIcon
                    component="div"
                    color="red"
                    radius="xl"
                    style={{
                      backgroundColor: rgba(theme.colors.red[9], 0.6),
                      color: 'white',
                      backdropFilter: 'blur(7px)',
                      boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
                      zIndex: 10,
                    }}
                    onClick={toggle}
                  >
                    {safe ? (
                      <IconEyeOff size={14} strokeWidth={2.5} />
                    ) : (
                      <IconEye size={14} strokeWidth={2.5} />
                    )}
                  </LegacyActionIcon>
                )}
              </ImageGuard2.BlurToggle>
              <MediaHash {...image} />
            </Center>
          ) : (
            <EdgeMedia
              src={image.url}
              name={image.name ?? image.id.toString()}
              alt={username ? `${username}'s Avatar` : undefined}
              type={image.type}
              loading="lazy"
              wrapperProps={{ style: { width: '100%', height: '100%' } }}
              contain
              style={{
                objectFit: 'cover',
                minHeight: '100%',
              }}
              optimized
              width={width}
              original={false}
            />
          )}
        </>
      )}
    </ImageGuard2>
  );
}
