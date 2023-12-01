import React from 'react';
import { Button, Center, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { ClubTier } from '~/types/router';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { constants } from '~/server/common/constants';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { useClubFeedStyles } from '~/components/Club/ClubFeed';
import {
  useClubContributorStatus,
  useMutateClub,
  useQueryClubMembership,
} from '~/components/Club/club.utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { openConfirmModal } from '@mantine/modals';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { formatDate } from '~/utils/date-helpers';
import dayjs from 'dayjs';
import { calculateClubTierNextBillingDate } from '~/utils/clubs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export const ClubTierItem = ({ clubTier }: { clubTier: ClubTier }) => {
  const { classes } = useClubFeedStyles();
  const { isOwner, isLoading: isLoadingOwnership } = useClubContributorStatus({
    clubId: clubTier.clubId,
  });
  const { data: membership, isLoading } = trpc.clubMembership.getClubMembershipOnClub.useQuery({
    clubId: clubTier.clubId,
  });
  const {
    creatingClubMembership,
    createClubMembership,
    updateClubMembership,
    updatingClubMembership,
  } = useMutateClub({
    clubId: clubTier.clubId,
  });

  const updating = updatingClubMembership || creatingClubMembership;
  const isTierMember = membership?.clubTier?.id === clubTier.id;

  const TierCoverImage = () =>
    clubTier.coverImage ? (
      <Center>
        <ImageCSSAspectRatioWrap
          aspectRatio={1}
          style={{ width: constants.clubs.tierImageSidebarDisplayWidth }}
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
                      </div>
                    </>
                  )}
                </ImageGuard.Content>
              );
            }}
          />
        </ImageCSSAspectRatioWrap>
      </Center>
    ) : null;

  const handleMembershipJoin = async () => {
    openConfirmModal({
      modalId: 'club-membership-create',
      centered: true,
      title: 'You are about to become a member of this club tier',
      children: (
        <Center>
          <Stack>
            <TierCoverImage />
            <Text align="center" weight={800}>
              {clubTier.name}
            </Text>
            <Text align="center">
              You will be charged the membership fee immediately and get access to this tier&rsquo;s
              benefits. Memberships are billed monthly and can be canceled at any time.
            </Text>

            <Text color="dimmed" size="sm" align="center">
              Your next billing date will be on {formatDate(dayjs().add(1, 'month').toDate())}
            </Text>
          </Stack>
        </Center>
      ),
      labels: { cancel: `No`, confirm: `Yes` },
      closeOnConfirm: true,
      onConfirm: async () => {
        try {
          await createClubMembership({
            clubTierId: clubTier.id,
          });

          showSuccessNotification({
            title: 'Success',
            message: 'You are now a member of this club! Enjoy your stay.',
          });
        } catch (err) {
          // Do nothing, alert is handled in the hook
        }
      },
    });
  };

  const isUpgrade = membership && !isTierMember && membership.unitAmount < clubTier.unitAmount;
  const isDowngrade = membership && !isTierMember && membership.unitAmount > clubTier.unitAmount;
  const isNextDowngradeTier = membership && membership.downgradeClubTierId === clubTier.id;

  const handleMembershipUpdate = async () => {
    const onUpdateMembership = async () => {
      try {
        updateClubMembership({
          clubTierId: clubTier.id,
        });

        showSuccessNotification({
          title: 'Success',
          message: 'Your membership has been upgraded.',
        });
      } catch {
        // Do nothing. Handled in the hook.
      }
    };

    if (isUpgrade) {
      const { nextBillingDate, addedDaysFromCurrentTier } = calculateClubTierNextBillingDate({
        membership,
        upgradeTier: clubTier,
      });

      openConfirmModal({
        modalId: 'club-membership-create',
        centered: true,
        title: 'You are about to change your current membership to this club tier',
        children: (
          <Center>
            <Stack>
              <TierCoverImage />
              <Text align="center" weight={800}>
                {clubTier.name}
              </Text>
              <Text align="center">
                You will be charged the membership fee{' '}
                <Text component="span" weight="bold">
                  immediately
                </Text>{' '}
                and get access to this tier&rsquo;s benefits.
              </Text>

              <Stack mt="md">
                <Text align="center" weight="bold">
                  Your next billing date will be on {formatDate(nextBillingDate)}.
                </Text>
                <Text color="dimmed" align="center" size="sm">
                  An additional{' '}
                  <Text component="span" weight="bold">
                    {addedDaysFromCurrentTier} days
                  </Text>{' '}
                  will be added to your new membership period to account for the remaining days in
                  your current membership.
                </Text>
              </Stack>
            </Stack>
          </Center>
        ),
        labels: { cancel: `Cancel`, confirm: `Confirm` },
        closeOnConfirm: true,
        onConfirm: onUpdateMembership,
      });
    } else {
      openConfirmModal({
        modalId: 'club-membership-create',
        centered: true,
        title: 'You are about to change your current membership to this club tier',
        children: (
          <Center>
            <Stack>
              <TierCoverImage />
              <Text align="center" weight={800}>
                {clubTier.name}
              </Text>
              <Text align="center">
                You will not be charged at this time. Your membership will be updated at your next
                billing date on {formatDate(membership?.nextBillingAt)}.
              </Text>
            </Stack>
          </Center>
        ),
        labels: { cancel: `Cancel`, confirm: `Confirm` },
        closeOnConfirm: true,
        onConfirm: onUpdateMembership,
      });
    }
  };

  return (
    <Paper className={classes.feedContainer}>
      <Stack style={{ flex: 1 }}>
        <TierCoverImage />

        <Stack align="center" spacing={4}>
          <Title order={4}>{clubTier.name}</Title>
          <CurrencyBadge
            size="lg"
            currency={clubTier.currency}
            unitAmount={clubTier.unitAmount}
            w="100%"
          />
        </Stack>
        <ContentClamp maxHeight={200}>
          <RenderHtml html={clubTier.description} />
        </ContentClamp>
        {!isOwner && !isLoading && !isLoadingOwnership && (
          <>
            {isNextDowngradeTier ? (
              <Button loading={updating} radius="md" color="yellow.7" variant="light">
                Active on {formatDate(membership.nextBillingAt)}
              </Button>
            ) : isTierMember ? (
              <Button
                loading={updating}
                radius="md"
                color="yellow.7"
                variant="light"
                onClick={membership.downgradeClubTierId ? handleMembershipUpdate : undefined}
              >
                Active{' '}
                {membership.expiresAt
                  ? `until ${formatDate(membership.expiresAt)}`
                  : membership.downgradeClubTierId
                  ? `until ${formatDate(membership.nextBillingAt)}`
                  : null}
              </Button>
            ) : isDowngrade ? (
              <Button
                loading={updating}
                radius="md"
                color="yellow.7"
                variant="light"
                onClick={handleMembershipUpdate}
              >
                Downgrade
              </Button>
            ) : (
              <BuzzTransactionButton
                disabled={updating}
                loading={updating}
                buzzAmount={clubTier.unitAmount}
                radius="md"
                onPerformTransaction={isUpgrade ? handleMembershipUpdate : handleMembershipJoin}
                label={isUpgrade ? 'Upgrade' : 'Become a member'}
              />
            )}
          </>
        )}
      </Stack>
    </Paper>
  );
};
