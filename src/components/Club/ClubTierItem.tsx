import { Alert, Anchor, Button, Center, Paper, Stack, Text, Title } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { Currency } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';
import { useRouter } from 'next/router';
import React from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useClubContributorStatus, useMutateClub } from '~/components/Club/club.utils';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
// import { dialogStore } from '~/components/Dialog/dialogStore';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
// import { StripePaymentMethodSetupModal } from '~/components/Modals/StripePaymentMethodSetupModal';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { useUserPaymentMethods } from '~/components/Stripe/stripe.utils';
import { constants } from '~/server/common/constants';
import type { ClubMembershipOnClub, ClubTier } from '~/types/router';
import { calculateClubTierNextBillingDate } from '~/utils/clubs';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import classes from '~/components/Club/ClubPost/ClubFeed.module.scss';

export const ClubMembershipStatus = ({ clubId }: { clubId: number }) => {
  const { data: membership } = trpc.clubMembership.getClubMembershipOnClub.useQuery({
    clubId,
  });
  const { isCancelled, isToggling, toggleCancelStatus } = useToggleClubMembershipCancelStatus({
    clubId,
  });

  if (!membership) {
    return null;
  }

  return (
    <>
      {membership?.clubTier?.oneTimeFee ? (
        <Alert color="yellow">
          <Stack>
            <Text size="sm">You are a member of this club.</Text>
            <Text size="sm">
              You have a one time payment membership on the club tier &rsquo;
              {membership.clubTier.name}&rsquo;.
            </Text>

            <Button
              size="xs"
              onClick={toggleCancelStatus}
              loading={isToggling}
              variant="subtle"
              color="yellow"
            >
              Exit club
            </Button>
          </Stack>
        </Alert>
      ) : membership?.cancelledAt ? (
        <Alert color="yellow">
          <Stack>
            <Text size="sm">
              Your membership was cancelled on {formatDate(membership.cancelledAt)} and will be
              active until{' '}
              <Text fw="bold" component="span">
                {formatDate(membership.expiresAt)}
              </Text>
              .
            </Text>
            <Button
              size="xs"
              onClick={toggleCancelStatus}
              loading={isToggling}
              variant="subtle"
              color="yellow"
            >
              {isCancelled ? 'Restore membership' : 'Cancel membership'}
            </Button>
          </Stack>
        </Alert>
      ) : membership?.nextBillingAt ? (
        <Alert color="yellow">
          <Stack gap={4}>
            <Text size="sm">You are a member of this club.</Text>
            {membership?.unitAmount > 0 && (
              <>
                <Text size="sm">
                  Your next billing date is{' '}
                  <Text fw="bold" component="span">
                    {formatDate(membership.nextBillingAt)}
                  </Text>
                  .
                </Text>
                <Text>
                  Your monthly fee is{' '}
                  <CurrencyBadge unitAmount={membership.unitAmount} currency={Currency.BUZZ} />.
                </Text>
              </>
            )}
            <Button
              size="xs"
              onClick={toggleCancelStatus}
              loading={isToggling}
              variant="subtle"
              color="yellow"
              mt="md"
            >
              {isCancelled ? 'Restore membership' : 'Cancel membership'}
            </Button>
          </Stack>
        </Alert>
      ) : null}
    </>
  );
};

export const TierCoverImage = ({
  clubTier,
}: {
  clubTier: ClubTier | NonNullable<ClubMembershipOnClub>['clubTier'];
}) =>
  clubTier.coverImage ? (
    <Center>
      Not implemented
      {/* <ImageCSSAspectRatioWrap
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
      </ImageCSSAspectRatioWrap> */}
    </Center>
  ) : null;

export const ClubTierItem = ({ clubTier }: { clubTier: ClubTier }) => {
  const router = useRouter();
  const { isOwner, isLoading: isLoadingOwnership } = useClubContributorStatus({
    clubId: clubTier.clubId,
  });
  const { data: membership, isLoading } = trpc.clubMembership.getClubMembershipOnClub.useQuery({
    clubId: clubTier.clubId,
  });
  const { userPaymentMethods } = useUserPaymentMethods();
  const { isToggling, toggleCancelStatus } = useToggleClubMembershipCancelStatus({
    clubId: clubTier.clubId,
  });

  const {
    creatingClubMembership,
    createClubMembership,
    updateClubMembership,
    updatingClubMembership,
  } = useMutateClub();

  const updating = updatingClubMembership || creatingClubMembership || isToggling;

  const isTierMember = membership?.clubTier?.id === clubTier.id;
  const remainingSpots = clubTier.memberLimit
    ? Math.max(0, clubTier.memberLimit - clubTier._count.memberships)
    : undefined;

  const handleMembershipJoin = async () => {
    openConfirmModal({
      modalId: 'club-membership-create',
      centered: true,
      title: 'You are about to become a member of this club tier',
      children: (
        <Center>
          <Stack>
            <TierCoverImage clubTier={clubTier} />
            <Text align="center" fw={800}>
              {clubTier.name}
            </Text>
            {clubTier.unitAmount > 0 ? (
              <>
                <Text align="center">
                  You will be charged the membership fee of{' '}
                  <CurrencyBadge unitAmount={clubTier.unitAmount} currency={Currency.BUZZ} />{' '}
                  immediately and get access to this tier&rsquo;s benefits.
                </Text>
                {clubTier.oneTimeFee ? (
                  <Text align="center">
                    This is a one time payment and you will not be charged again.
                  </Text>
                ) : (
                  <>
                    <Text align="center">
                      Memberships are billed monthly and can be canceled at any time.
                    </Text>
                    <Text c="dimmed" size="sm" align="center">
                      Your next billing date will be on{' '}
                      {formatDate(dayjs().add(1, 'month').toDate())}
                    </Text>
                  </>
                )}
              </>
            ) : (
              <Text>
                You&rsquo;re about to join a FREE tier for this club. This means you will be getting
                notifciations and access to some club resources and exclusive posts. No charges will
                be made to your account.
              </Text>
            )}
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

          if (userPaymentMethods.length === 0 && clubTier.unitAmount > 0 && !clubTier.oneTimeFee) {
            // dialogStore.trigger({
            //   component: StripePaymentMethodSetupModal,
            //   props: {
            //     redirectUrl: router.asPath,
            //     title: (
            //       <Text size="lg" fw={700}>
            //         You are now a member of this club! Enjoy your stay
            //       </Text>
            //     ),
            //     message: (
            //       <Stack>
            //         <Text>
            //           Your membership to this club is a subscription, meaning{' '}
            //           <CurrencyBadge unitAmount={clubTier.unitAmount} currency={Currency.BUZZ} />{' '}
            //           will be debited from your account on the specified billing date. To ensure you
            //           have enough buzz on your next renewal, it&apos;s recommended that you add a
            //           payment method. Doing so is the ideal way to keep supporting the creators you
            //           care about.
            //         </Text>
            //         <Text fw="bold">
            //           Your card will only be charged if you do not have the amount of buzz at the
            //           time of renewal to continue your membership. A minimum of{' '}
            //           <CurrencyBadge
            //             unitAmount={constants.clubs.minStripeCharge / 10}
            //             currency={Currency.USD}
            //           />{' '}
            //           will be charged to your card only in the case that you do not have enough buzz
            //           to cover the membership fee.
            //         </Text>
            //         <Text>
            //           You can always add a payment method later in your{' '}
            //           <Anchor href="/user/account#payment-methods">account settings.</Anchor>
            //         </Text>
            //       </Stack>
            //     ),
            //   },
            // });
          }
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
              <TierCoverImage clubTier={clubTier} />
              <Text align="center" fw={800}>
                {clubTier.name}
              </Text>
              <Text align="center">
                You will be charged the membership fee{' '}
                <Text component="span" fw="bold">
                  immediately
                </Text>{' '}
                and get access to this tier&rsquo;s benefits.
              </Text>

              {clubTier.oneTimeFee ? (
                <Stack mt="md">
                  <Text align="center" fw="bold">
                    This is a one time payment and you will not be charged again unless leave the
                    club.
                  </Text>
                </Stack>
              ) : (
                <Stack mt="md">
                  <Text align="center" fw="bold">
                    Your next billing date will be on {formatDate(nextBillingDate)}.
                  </Text>
                  <Text c="dimmed" align="center" size="sm">
                    An additional{' '}
                    <Text component="span" fw="bold">
                      {addedDaysFromCurrentTier} days
                    </Text>{' '}
                    will be added to your new membership period to account for the remaining days in
                    your current membership.
                  </Text>
                </Stack>
              )}
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
              <TierCoverImage clubTier={clubTier} />
              <Text align="center" fw={800}>
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
        <TierCoverImage clubTier={clubTier} />

        <Stack align="center" gap={4}>
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

        {!isOwner && (
          <LoginPopover>
            {isNextDowngradeTier ? (
              <Button loading={updating} radius="md" color="yellow.7" variant="light">
                Active on {formatDate(membership.nextBillingAt)}
              </Button>
            ) : isTierMember ? (
              <Stack gap={4}>
                <Button
                  loading={updating}
                  radius="md"
                  color="yellow.7"
                  variant="light"
                  onClick={
                    membership.downgradeClubTierId ? handleMembershipUpdate : toggleCancelStatus
                  }
                >
                  Active{' '}
                  {membership.expiresAt
                    ? `until ${formatDate(membership.expiresAt)}`
                    : membership.downgradeClubTierId
                    ? `until ${formatDate(membership.nextBillingAt)}`
                    : null}
                </Button>
                {membership?.cancelledAt && (
                  <Text size="xs" align="center">
                    Click to restore
                  </Text>
                )}
              </Stack>
            ) : isDowngrade ? (
              <Button
                loading={updating}
                radius="md"
                color="yellow.7"
                variant="light"
                onClick={handleMembershipUpdate}
                disabled={remainingSpots === 0 || membership?.clubTier.oneTimeFee}
              >
                Downgrade
              </Button>
            ) : (
              <BuzzTransactionButton
                disabled={updating || remainingSpots === 0}
                loading={updating}
                buzzAmount={clubTier.unitAmount}
                radius="md"
                onPerformTransaction={isUpgrade ? handleMembershipUpdate : handleMembershipJoin}
                label={
                  isUpgrade ? 'Upgrade' : clubTier.oneTimeFee ? 'Get Access ' : 'Become a member'
                }
                color="yellow.7"
              />
            )}
          </LoginPopover>
        )}
        {remainingSpots !== undefined && (
          <Text align="center" size="xs" c="yellow.7">
            {remainingSpots} spots left
          </Text>
        )}
      </Stack>
    </Paper>
  );
};

export const useToggleClubMembershipCancelStatus = ({ clubId }: { clubId: number }) => {
  const {
    cancelClubMembership,
    cancelingClubMembership,
    restoreClubMembership,
    restoringClubMembership,
  } = useMutateClub();

  const { data: membership, isLoading } = trpc.clubMembership.getClubMembershipOnClub.useQuery({
    clubId,
  });

  const clubTier = membership?.clubTier;

  const handleMembershipRestore = async () => {
    try {
      await restoreClubMembership({
        clubId,
      });

      showSuccessNotification({
        title: 'Success',
        message: `Your membership has been restored. Your next billing date is ${formatDate(
          membership?.nextBillingAt
        )}.`,
      });
    } catch {
      // Do nothing. Handled in the hook.
    }
  };

  const handleMembershipCancel = async () => {
    if (!clubTier) {
      return;
    }

    const onCancelMembership = async () => {
      try {
        await cancelClubMembership({
          clubId,
        });

        showSuccessNotification({
          title: 'Success',
          message: `Your membership has been canceled.`,
        });
      } catch {
        // Do nothing. Handled in the hook.
      }
    };

    openConfirmModal({
      modalId: 'club-membership-cancel',
      centered: true,
      title: 'You are about to cancel your current membership',
      children: (
        <Center>
          <Stack>
            <TierCoverImage clubTier={clubTier} />
            <Text align="center" fw={800}>
              {clubTier.name}
            </Text>
            {clubTier.unitAmount > 0 && !clubTier.oneTimeFee ? (
              <Text align="center">
                Your membership will be canceled at the end of your current billing period on{' '}
                {formatDate(membership?.nextBillingAt)} and no more charges to your account will be
                made.
              </Text>
            ) : (
              <Text align="center">
                Your membership will be canceled right away and you will lose access to this
                club&rsquo;s resources
              </Text>
            )}
          </Stack>
        </Center>
      ),
      labels: { cancel: `Cancel`, confirm: `Confirm` },
      closeOnConfirm: true,
      onConfirm: onCancelMembership,
    });
  };

  const toggleCancelStatus = membership?.cancelledAt
    ? handleMembershipRestore
    : handleMembershipCancel;

  return {
    membership,
    isLoadingMembership: isLoading,
    isCancelled: membership?.cancelledAt,
    isToggling: cancelingClubMembership || restoringClubMembership,
    toggleCancelStatus,
  };
};
