import { openConfirmModal } from '@mantine/modals';
import { Stack, Text } from '@mantine/core';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { IconAward } from '@tabler/icons-react';
import React from 'react';
import { trpc } from '~/utils/trpc';
import produce from 'immer';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { BountyGetById } from '~/types/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getBountyCurrency } from '~/components/Bounty/bounty.utils';

export const AwardBountyAction = ({
  bountyEntryId,
  bounty,
  children,
}: {
  bountyEntryId: number;
  bounty: BountyGetById;
  children: ({
    onClick,
    isLoading,
  }: {
    onClick: (e: React.MouseEvent) => void;
    isLoading: boolean;
  }) => React.ReactElement;
}) => {
  const queryUtils = trpc.useContext();
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
        const prevEntry = queryUtils.bountyEntry.getById.getData({ id: bountyEntryId });

        const benefactorItem = bounty.benefactors.find((b) => b.user.id === currentUser.id);

        if (prevBounty) {
          console.log('prevBounty', prevBounty);

          await queryUtils.bounty.getById.setData(
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

          await queryUtils.bounty.getEntries.setData(
            { id: bounty.id },
            produce((entries) => {
              if (!entries || !benefactorItem) {
                return entries;
              }

              return entries.map((entry) => {
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
          await queryUtils.bountyEntry.getById.setData(
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
      onSuccess: async (_) => {
        showSuccessNotification({
          title: 'You have awarded an entry!',
          message: `Your selected entry has been awarded!`,
        });

        await queryUtils.bountyEntry.getFiles.invalidate({ id: bountyEntryId });
      },
      onError: async (error, _variables, context) => {
        showErrorNotification({
          title: 'There was an error awarding the entry',
          error: new Error(error.message),
        });

        if (context?.prevBounty) {
          await queryUtils.bounty.getById.setData({ id: bounty.id }, context.prevBounty);
        }

        if (context?.prevEntries) {
          await queryUtils.bounty.getEntries.setData({ id: bounty.id }, context.prevEntries);
        }

        if (context?.prevEntry) {
          await queryUtils.bountyEntry.getById.setData({ id: bountyEntryId }, context.prevEntry);
        }
      },
    });

  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!benefactorItem) {
      return;
    }

    openConfirmModal({
      title: 'Award this entry?',
      children: (
        <Stack>
          <Text>
            Are you sure you want to award{' '}
            {<CurrencyBadge currency={currency} unitAmount={benefactorItem.unitAmount ?? 0} />} to
            this entry?
          </Text>
          <Text>
            You will gain access to the files whose unlock amount have been reached after awarding.
          </Text>
          <Text color="red.4" size="sm">
            This action is non refundable.
          </Text>
        </Stack>
      ),
      centered: true,
      labels: { confirm: 'Award this entry', cancel: 'No, go back' },
      confirmProps: { color: 'yellow.7', rightIcon: <IconAward size={20} /> },
      onConfirm: () => {
        awardBountyEntryMutation({ id: bountyEntryId });
      },
    });
  };

  if (!benefactorItem || benefactorItem.awardedToId) {
    return null;
  }

  return children({ onClick, isLoading: isAwardingBountyEntry });
};
