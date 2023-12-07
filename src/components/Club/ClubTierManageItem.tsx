import React, { useState } from 'react';
import { IconPencilMinus, IconTrash, IconUser } from '@tabler/icons-react';
import { Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { ClubTier } from '~/types/router';
import { numberWithCommas } from '~/utils/number-helpers';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { constants } from '~/server/common/constants';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { ClubTierUpsertForm } from '~/components/Club/ClubTierUpsertForm';
import { useClubFeedStyles } from '~/components/Club/ClubPost/ClubFeed';

export const ClubTierManageItem = ({ clubTier }: { clubTier: ClubTier }) => {
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const { classes } = useClubFeedStyles();

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
        {clubTier.coverImage && (
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
        )}
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
            >
              Edit
            </Button>
            <Button color="red" onClick={() => {}} leftIcon={<IconTrash />}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Group>
    </Paper>
  );
};
