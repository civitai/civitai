import React, { useState } from 'react';
import { IconPencilMinus, IconTrash, IconUser } from '@tabler/icons-react';
import { Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { ClubTier } from '~/types/router';
import { numberWithCommas } from '~/utils/number-helpers';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { constants } from '~/server/common/constants';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { ClubTierUpsertForm } from '~/components/Club/ClubTierUpsertForm';
import { useClubFeedStyles } from '~/components/Club/ClubPost/ClubFeed';
import { useMutateClub } from './club.utils';
import { showSuccessNotification } from '../../utils/notifications';
import { openConfirmModal } from '@mantine/modals';

export const ClubTierManageItem = ({ clubTier }: { clubTier: ClubTier }) => {
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const { classes } = useClubFeedStyles();
  const { deleteClubTier, deletingTier } = useMutateClub();

  const onDeleteClubTier = async () => {
    openConfirmModal({
      title: 'Delete club tier',
      children: (
        <Stack>
          <Text size="sm">
            Are you sure you want to delete this club tier? This action is destructive and cannot be
            reverted. all resources tied to this club tier will be made public unless they belong in
            other clubs or tiers.
          </Text>
        </Stack>
      ),
      centered: true,
      labels: { confirm: 'Delete club tier', cancel: 'Cancel' },
      confirmProps: { color: 'red', loading: deletingTier },
      onConfirm: async () => {
        await deleteClubTier({ id: clubTier.id });

        showSuccessNotification({
          title: 'Club tier removed',
          message: `Club tier has been removed from this club and all resources have been updated.`,
        });
      },
    });
  };

  if (isEditing) {
    return (
      <Paper className={classes.feedContainer}>
        <ClubTierUpsertForm
          clubTier={clubTier}
          clubId={clubTier.clubId}
          onSuccess={() => setIsEditing(false)}
          onCancel={() => setIsEditing(false)}
        />
      </Paper>
    );
  }

  return (
    <Paper className={classes.feedContainer}>
      <Group align="flex-start">
        {/* {clubTier.coverImage && (
          <ImageCSSAspectRatioWrap
            aspectRatio={1}
            style={{ width: constants.clubs.tierImageDisplayWidth }}
          >
            <ImageGuard
              images={[clubTier.coverImage]}
              connect={{ entityId: clubTier.clubId, entityType: 'club' }}
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
                            edgeImageProps={{ width: 450 }}
                            radius="md"
                            style={{ width: '100%', height: '100%' }}
                            aspectRatio={0}
                          />
                        )}
                        <div style={{ width: '100%', height: '100%' }}>
                          <ImageGuard.ToggleConnect position="top-left" />
                          <ImageGuard.Report withinPortal />
                        </div>
                      </>
                    )}
                  </ImageGuard.Content>
                );
              }}
            />
          </ImageCSSAspectRatioWrap>
        )} */}
        <Stack style={{ flex: 1 }}>
          <Group position="apart">
            <Stack>
              <Group>
                <Title order={3}>{clubTier.name}</Title>
                <Group spacing={0}>
                  <IconUser />
                  <Text color="dimmed">
                    {numberWithCommas(clubTier._count?.memberships ?? 0) || 0}
                  </Text>
                </Group>
              </Group>
            </Stack>
            <CurrencyBadge
              size="lg"
              currency={clubTier.currency}
              unitAmount={clubTier.unitAmount}
            />
          </Group>
          <ContentClamp maxHeight={200}>
            <RenderHtml html={clubTier.description} />
          </ContentClamp>

          <Group>
            <Button
              onClick={() => {
                setIsEditing(true);
              }}
              leftIcon={<IconPencilMinus />}
              disabled={deletingTier}
            >
              Edit
            </Button>
            <Button
              color="red"
              onClick={onDeleteClubTier}
              loading={deletingTier}
              leftIcon={<IconTrash />}
            >
              Delete
            </Button>
          </Group>
        </Stack>
      </Group>
    </Paper>
  );
};
