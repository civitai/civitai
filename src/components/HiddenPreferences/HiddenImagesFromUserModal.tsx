import { Alert, Badge, Center, Loader, Modal, Stack, Text } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { HideImageButton } from '~/components/HideImageButton/HideImageButton';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { trpc } from '~/utils/trpc';

export default function HiddenImagesFromUserModal({
  userId,
  username,
}: {
  userId: number;
  username?: string | null;
}) {
  const dialog = useDialogContext();
  const { data, isLoading } = trpc.hiddenPreferences.getHiddenImagesForUser.useQuery({ userId });

  const items = data?.items ?? [];

  return (
    <Modal
      {...dialog}
      size="lg"
      title={username ? `Hidden images from ${username}` : 'Hidden images'}
    >
      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : !items.length ? (
        <Text c="dimmed" size="sm">
          You haven&apos;t hidden any images from this creator.
        </Text>
      ) : (
        <Stack gap="md">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {items.map((image) => (
              <Stack key={image.id} gap={4}>
                <div className="relative aspect-square overflow-hidden rounded-md bg-gray-2 dark:bg-dark-6">
                  <ImageGuard2 image={image} explain={false}>
                    {(safe) =>
                      // `canViewMedia` is false once the image stopped being
                      // viewable elsewhere (taken down, unpublished, made
                      // private) — the row stays so it can be unhidden.
                      !safe || !image.canViewMedia || !image.url ? (
                        <MediaHash {...image} style={{ width: '100%', height: '100%' }} />
                      ) : (
                        <EdgeMedia
                          src={image.url}
                          name={image.name ?? image.id.toString()}
                          alt={image.name ?? undefined}
                          type={image.type}
                          width={450}
                          className="size-full object-cover"
                        />
                      )
                    }
                  </ImageGuard2>
                  {image.isProfileCover && (
                    <Badge className="absolute left-1 top-1" size="sm" variant="filled">
                      Profile cover
                    </Badge>
                  )}
                </div>
                {!image.canViewMedia && (
                  <Text size="xs" c="dimmed">
                    No longer available
                  </Text>
                )}
                {/* A post-less image (a profile cover is one) has no image page a
                    non-owner can open — linking there would 404. */}
                {image.postId && image.canViewMedia && (
                  <Text
                    component={Link}
                    href={`/images/${image.id}`}
                    target="_blank"
                    size="xs"
                    c="blue.4"
                  >
                    View image
                  </Text>
                )}
                <HideImageButton imageId={image.id} size="compact-xs" fullWidth />
              </Stack>
            ))}
          </div>
          {data?.hasMore && (
            <Alert color="yellow">
              Showing the {items.length} most recently hidden. Unhide some to see the rest.
            </Alert>
          )}
        </Stack>
      )}
    </Modal>
  );
}
