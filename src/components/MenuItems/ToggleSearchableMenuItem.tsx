import { Menu } from '@mantine/core';
import { IconSearch, IconSearchOff } from '@tabler/icons-react';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { SupportedAvailabilityResources } from '../../server/schema/base.schema';
import { trpc } from '~/utils/trpc';
import { Availability } from '@prisma/client';

export function ToggleSearchableMenuItem({ entityType, entityId }: Props) {
  const currentUser = useCurrentUser();
  const utils = trpc.useContext();
  const { data: entities = [], isLoading: isLoadingAccess } = trpc.common.getEntityAccess.useQuery(
    {
      entityId: [entityId],
      entityType: entityType,
    },
    {
      enabled: currentUser?.isModerator,
    }
  );
  const [entity] = entities ?? [];
  const { mutateAsync: onUpdateAvailability } = trpc.common.updateAvailability.useMutation({
    onSuccess: (_, { availability }) => {
      utils.common.getEntityAccess.setData(
        {
          entityId: [entityId],
          entityType: entityType,
        },
        (prev) => {
          if (!prev) {
            return prev;
          }

          return [
            {
              ...prev[0],
              availability: availability,
            },
          ];
        }
      );
    },
  });

  if (!currentUser?.isModerator || !entity) {
    return null;
  }

  const isSearchable = entity.availability === Availability.Public;

  if (isLoadingAccess) {
    return (
      <Menu.Item icon={<IconSearch size={14} stroke={1.5} />} disabled>
        &hellip;Loading&hellip;
      </Menu.Item>
    );
  }

  return (
    <Menu.Item
      icon={
        isSearchable ? (
          <IconSearchOff size={14} stroke={1.5} />
        ) : (
          <IconSearch size={14} stroke={1.5} />
        )
      }
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onUpdateAvailability({
          entityId: entityId,
          entityType: entityType,
          availability: isSearchable ? Availability.Unsearchable : Availability.Public,
        });
      }}
    >
      {isSearchable ? `Remove ${entityType} from search` : `Add ${entityType} to search`}
    </Menu.Item>
  );
}

type Props = { entityType: SupportedAvailabilityResources; entityId: number };
