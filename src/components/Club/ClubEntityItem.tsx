import { ClubEntityById } from '~/types/router';
import { Button, Container, Paper, Stack, Text, Title } from '@mantine/core';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { IconAlertCircle } from '@tabler/icons-react';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { constants } from '~/server/common/constants';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import Link from 'next/link';
import React from 'react';
import { SupportedClubEntities } from '~/server/schema/club.schema';
import { useClubFeedStyles } from '~/components/Club/ClubFeed';
import { Username } from '~/components/User/Username';
import { formatDate } from '~/utils/date-helpers';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';

const ClubEntityItemDetails = ({ clubEntity }: { clubEntity: ClubEntityById }) => {
  if (!clubEntity || !clubEntity.addedBy) return null;

  return (
    <UserAvatar
      user={clubEntity.addedBy}
      size="md"
      subText={`Posted on ${formatDate(clubEntity.addedAt)}`}
      withUsername
    />
  );
};

const getEntityUrl = ({
  entityType,
  entityId,
}: {
  entityType: SupportedClubEntities;
  entityId: number;
}) => {
  switch (entityType) {
    case 'Model':
      return `/models/${entityId}`;
    case 'Article':
      return `/articles/${entityId}`;
  }
};

const ClubEntityItemWithAccess = ({ clubEntity }: { clubEntity: ClubEntityById }) => {
  const { classes } = useClubFeedStyles();

  if (!clubEntity || clubEntity.type !== 'hasAccess') return null;

  const { entityId, entityType } = clubEntity;

  return (
    <Paper className={classes.feedContainer}>
      <Stack>
        <ClubEntityItemDetails clubEntity={clubEntity} />
        {clubEntity.coverImage && (
          <ImageCSSAspectRatioWrap aspectRatio={constants.clubs.postCoverImageAspectRatio}>
            <ImageGuard
              images={[clubEntity.coverImage]}
              connect={{ entityId: clubEntity.clubId, entityType: 'club' }}
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
        <Title order={3}>{clubEntity.title}</Title>
        <RenderHtml html={clubEntity.description} />
        <Link href={getEntityUrl({ entityId, entityType })} passHref>
          <Button fullWidth>Checkout this resource</Button>
        </Link>
      </Stack>
    </Paper>
  );
};

const ClubEntityItemMembershipRequired = ({ clubEntity }: { clubEntity: ClubEntityById }) => {
  const { classes } = useClubFeedStyles();

  if (!clubEntity || clubEntity.type !== 'membersOnlyNoAccess') {
    return null;
  }

  return (
    <Paper className={classes.feedContainer}>
      <AlertWithIcon icon={<IconAlertCircle />} px="xs">
        This model requires a membership to view.
      </AlertWithIcon>
    </Paper>
  );
};

const ClubEntityItemNoMembershipRequiredNoAccess = ({
  clubEntity,
}: {
  clubEntity: ClubEntityById;
}) => {
  const { classes } = useClubFeedStyles();

  if (!clubEntity || clubEntity.type !== 'noAccess') {
    return null;
  }

  return (
    <Paper className={classes.feedContainer}>
      <Stack>
        <ClubEntityItemDetails clubEntity={clubEntity} />
        {clubEntity.coverImage && (
          <ImageCSSAspectRatioWrap aspectRatio={constants.clubs.postCoverImageAspectRatio}>
            <MediaHash {...clubEntity.coverImage} style={{ width: '100%', height: '100%' }} />
          </ImageCSSAspectRatioWrap>
        )}
        <Title order={3}>{clubEntity.title}</Title>
        <RenderHtml html={clubEntity.description} />
        <Button
          onClick={() => {
            console.log('Open new modal');
          }}
          color="yellow.7"
        >
          Become a member to unlock this resource
        </Button>
      </Stack>
    </Paper>
  );
};
export const ClubEntityItem = ({ clubEntity }: { clubEntity: ClubEntityById }) => {
  if (!clubEntity) return null;

  if (clubEntity.type === 'membersOnlyNoAccess') {
    // Requires a club membership to view.
    return <ClubEntityItemMembershipRequired clubEntity={clubEntity} />;
  }

  if (clubEntity.type === 'noAccess') {
    // Requires a club membership to view.
    return <ClubEntityItemNoMembershipRequiredNoAccess clubEntity={clubEntity} />;
  }

  return <ClubEntityItemWithAccess clubEntity={clubEntity} />;
};
