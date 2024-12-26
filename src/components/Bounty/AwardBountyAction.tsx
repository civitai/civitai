import { openConfirmModal } from '@mantine/modals';
import { Center, Stack, Text } from '@mantine/core';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { IconAward } from '@tabler/icons-react';
import React from 'react';
import { trpc } from '~/utils/trpc';
import produce from 'immer';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { BountyEntryGetById, BountyGetById } from '~/types/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getBountyCurrency } from '~/components/Bounty/bounty.utils';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { formatDate } from '~/utils/date-helpers';
import { useTrackEvent } from '../TrackView/track.utils';

export const AwardBountyAction = ({
  fileUnlockAmount,
  bountyEntry,
  bounty,
  children,
}: {
  fileUnlockAmount: number;
  bountyEntry: Pick<BountyEntryGetById, 'id' | 'createdAt' | 'user'>;
  bounty: BountyGetById;
  children: ({
    onClick,
    isLoading,
  }: {
    onClick: (e: React.MouseEvent) => void;
    isLoading: boolean;
  }) => React.ReactElement;
}) => {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const currency = getBountyCurrency(bounty);
  const benefactorItem = !currentUser
    ? null
    : bounty.benefactors.find((b) => b.user.id === currentUser.id);

  const { isLoading: isAwardingBountyEntry, mutate: awardBountyEntryMutation } =
    trpc.bountyEntry.award.useMutation({
      onMutate: async ({ id }) => {
        if (!currentUser) {
          return;
        }

        const prevEntries = queryUtils.bounty.getEntries.getData({ id: bounty.id });
        const prevBounty = queryUtils.bounty.getById.getData({ id: bounty.id });
        const prevEntry = queryUtils.bountyEntry.getById.getData({ id: bountyEntry.id });

        const benefactorItem = bounty.benefactors.find((b) => b.user.id === currentUser.id);

        if (prevBounty) {
          queryUtils.bounty.getById.setData(
            { id: bounty.id },
            produce((bounty) => {
              if (!bounty || !currentUser) {
                return bounty;
              }

              return {
                ...bounty,
                benefactors: bounty.benefactors.map((b) => {
                  if (b.user.id === currentUser?.id) {
                    return { ...b, awardedToId: id };
                  }

                  return b;
                }),
              };
            })
          );
        }

        if (prevEntries) {
          queryUtils.bounty.getEntries.setData(
            { id: bounty.id },
            produce((entries) => {
              if (!entries || !benefactorItem) {
                return entries;
              }

              return entries.items.map((entry) => {
                if (entry.id === id) {
                  return {
                    ...entry,
                    awardedUnitAmountTotal:
                      (entry.awardedUnitAmountTotal ?? 0) + benefactorItem.unitAmount,
                  };
                }

                return entry;
              });
            })
          );
        }

        if (prevEntry) {
          queryUtils.bountyEntry.getById.setData(
            { id: prevEntry.id },
            produce((entry) => {
              if (!entry) {
                return entry;
              }

              entry.awardedUnitAmountTotal =
                (entry.awardedUnitAmountTotal ?? 0) + (benefactorItem?.unitAmount ?? 0);

              return entry;
            })
          );
        }

        return {
          prevBounty,
          prevEntries,
          prevEntry,
        };
      },
      onSuccess: async () => {
        showSuccessNotification({
          title: 'You have awarded an entry!',
          message: `Your selected entry has been awarded!`,
        });

        await queryUtils.bountyEntry.getFiles.invalidate({ id: bountyEntry.id });
        await queryUtils.bounty.getById.invalidate({ id: bounty.id });
        await queryUtils.bounty.getInfinite.invalidate();
      },
      onError: async (error, _variables, context) => {
        showErrorNotification({
          title: 'There was an error awarding the entry',
          error: new Error(error.message),
        });

        if (context?.prevBounty) {
          queryUtils.bounty.getById.setData({ id: bounty.id }, context.prevBounty);
        }

        if (context?.prevEntries) {
          queryUtils.bounty.getEntries.setData({ id: bounty.id }, context.prevEntries);
        }

        if (context?.prevEntry) {
          queryUtils.bountyEntry.getById.setData({ id: bountyEntry.id }, context.prevEntry);
        }
      },
    });

  const { trackAction } = useTrackEvent();

  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    trackAction({ type: 'AwardBounty_Click' }).catch(() => undefined);

    if (!benefactorItem) {
      return;
    }

    openConfirmModal({
      title: 'Award this entry?',
      children: (
        <Stack>
          {bountyEntry && bountyEntry?.user && (
            <Center>
              <Stack>
                <Text size="xs" color="dimmed">
                  Entry added on {formatDate(bountyEntry.createdAt)} by
                </Text>
                <SmartCreatorCard user={bountyEntry.user} />
              </Stack>
            </Center>
          )}
          <Text>
            Are you sure you want to award{' '}
            {<CurrencyBadge currency={currency} unitAmount={benefactorItem.unitAmount ?? 0} />} to
            this entry?
          </Text>
          <Text>
            Awarding this entry will grant you access to all files uploaded by the entry creator.
          </Text>
          <Text color="red.4" size="sm">
            This action is non refundable.
          </Text>
          {/* TODO.bounty: turn this back on once we have open entries in place */}
          {/* {fileUnlockAmount > benefactorItem.unitAmount && (
            <Text color="red.4" size="sm">
              <strong>Note:</strong> Some files on this entry <strong>will not</strong> reach the
              unlock amount after awarding this entry. If the bounty expires before the unlock
              amount is reached, you will not gain access to these files and your funds not be
              returned but instead will be kept by the selected entry.
            </Text>
          )} */}
        </Stack>
      ),
      centered: true,
      labels: { confirm: 'Award this entry', cancel: 'No, go back' },
      confirmProps: { color: 'yellow.7', rightIcon: <IconAward size={20} /> },
      onConfirm: () => {
        awardBountyEntryMutation({ id: bountyEntry.id });
        trackAction({ type: 'AwardBounty_Confirm' }).catch(() => undefined);
      },
    });
  };

  if (!benefactorItem || benefactorItem.awardedToId) {
    return null;
  }

  return children({ onClick, isLoading: isAwardingBountyEntry });
};
