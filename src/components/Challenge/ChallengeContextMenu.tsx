import type { ActionIconProps, MenuProps } from '@mantine/core';
import { Menu } from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { IconEdit, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ActionIconDotsVertical } from '~/components/Cards/components/ActionIconDotsVertical';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDeleteUserChallenge } from '~/components/Challenge/challenge.utils';
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';

type Props = MenuProps & {
  challenge: { id: number; createdById: number; source: ChallengeSource; status: ChallengeStatus };
  buttonProps?: ActionIconProps;
};

export function ChallengeContextMenu({ challenge, buttonProps, ...menuProps }: Props) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { deleteChallenge, deleting } = useDeleteUserChallenge();

  const canManage =
    !!currentUser &&
    currentUser.id === challenge.createdById &&
    challenge.source === ChallengeSource.User &&
    challenge.status === ChallengeStatus.Scheduled;

  if (!canManage) return null;

  return (
    <Menu {...menuProps}>
      <Menu.Target>
        <ActionIconDotsVertical
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          {...buttonProps}
        />
      </Menu.Target>
      <Menu.Dropdown>
        <Link legacyBehavior href={`/challenges/${challenge.id}/edit`} passHref>
          <Menu.Item component="a" leftSection={<IconEdit size={14} stroke={1.5} />}>
            Edit
          </Menu.Item>
        </Link>
        <Menu.Item
          color="red"
          leftSection={<IconTrash size={14} stroke={1.5} />}
          disabled={deleting}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();
            openConfirmModal({
              title: 'Delete challenge',
              children:
                'Delete this challenge? Your escrowed prize Buzz will be refunded. This cannot be undone.',
              centered: true,
              closeOnConfirm: false,
              labels: { cancel: 'No, keep it', confirm: 'Delete challenge' },
              confirmProps: { color: 'red' },
              onConfirm: async () => {
                try {
                  await deleteChallenge(challenge.id);
                  closeAllModals();
                  const atDetails = router.pathname === '/challenges/[id]/[[...slug]]';
                  if (atDetails) await router.push('/challenges');
                } catch {
                  // notification is surfaced by the mutation's onError
                }
              },
            });
          }}
        >
          Delete
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
