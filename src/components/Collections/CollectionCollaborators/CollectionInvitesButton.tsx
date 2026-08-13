import { Indicator, Tooltip } from '@mantine/core';
import { IconMail } from '@tabler/icons-react';
import { openCollectionInvitesModal } from '~/components/Collections/CollectionCollaborators/openCollectionInvitesModal';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function CollectionInvitesButton() {
  const currentUser = useCurrentUser();
  const { data: invites } = trpc.collection.getMyInvites.useQuery(undefined, {
    enabled: !!currentUser,
  });

  if (!currentUser) return null;

  const count = invites?.length ?? 0;

  return (
    <Tooltip label="Invitations" position="bottom" openDelay={300}>
      <Indicator
        label={count > 9 ? '9+' : count}
        size={16}
        color="blue"
        disabled={count === 0}
        offset={4}
      >
        <LegacyActionIcon
          variant="subtle"
          color={count > 0 ? 'blue' : 'gray'}
          aria-label={count > 0 ? `Invitations (${count} pending)` : 'Invitations'}
          onClick={openCollectionInvitesModal}
        >
          <IconMail size={18} />
        </LegacyActionIcon>
      </Indicator>
    </Tooltip>
  );
}
