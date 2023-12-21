import { ClubResourceGetPaginatedItem, ClubTier } from '~/types/router';
import { updateClubResourceInput } from '~/server/schema/club.schema';
import { ActionIcon, Anchor, Button, Checkbox, Group, Tooltip } from '@mantine/core';
import React from 'react';
import { IconCheck, IconTrash } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import { useMutateClub } from '~/components/Club/club.utils';
import { getDisplayName } from '../../utils/string-helpers';

type Props = {
  resource: ClubResourceGetPaginatedItem;
  clubTiers: ClubTier[];
  onResourceRemoved?: (resource: ClubResourceGetPaginatedItem) => void;
  onResourceUpdated?: (resource: ClubResourceGetPaginatedItem) => void;
};
const getResourceDetails = (
  resource: ClubResourceGetPaginatedItem
): { label: string; url: string } => {
  switch (resource.entityType) {
    case 'ModelVersion':
      return {
        label: `${resource.data.name} - ${resource.data.modelVersion.name}`,
        url: `/models/${resource.data.id}?modelVersionId=${resource.data.modelVersion.id}`,
      };
    case 'Article':
      return {
        label: resource.data.title,
        url: `/articles/${resource.data.id}`,
      };
    case 'Post':
      return {
        label: resource.data.title || 'N/A', // Safeguard this one since posts can have no title.
        url: `/posts/${resource.data.id}`,
      };
  }
};
export const ClubResourcePagedUpdateForm = ({
  resource,
  clubTiers,
  onResourceRemoved,
  onResourceUpdated,
}: Props) => {
  const [clubTierIds, setClubTierIds] = React.useState<number[]>(resource.clubTierIds);
  const { label, url } = getResourceDetails(resource);
  const { updateResource, removeResource, removingResource, updatingResource } = useMutateClub();

  const isLoading = removingResource || updatingResource;

  const handleRemove = async () => {
    await removeResource({
      ...resource,
    });

    onResourceRemoved?.(resource);
  };

  const handleUpdate = async () => {
    await updateResource({
      ...resource,
      clubTierIds,
    });

    onResourceUpdated?.({
      ...resource,
      clubTierIds: clubTierIds,
    });
  };

  const isDirty = React.useMemo(() => {
    return !isEqual(clubTierIds, resource.clubTierIds);
  }, [clubTierIds]);

  return (
    <tr>
      <td>{getDisplayName(resource.entityType)}</td>
      <td>
        <Anchor href={url} target="_blank">
          {label}
        </Anchor>
      </td>
      <td>
        <Checkbox
          checked={(clubTierIds ?? []).length === 0}
          onChange={() => {
            setClubTierIds([]);
          }}
        />
      </td>
      {clubTiers.map((tier) => (
        <td key={tier.id}>
          <Checkbox
            key={tier.id}
            checked={clubTierIds.includes(tier.id)}
            onChange={() => {
              setClubTierIds((ids) => {
                if (ids.includes(tier.id)) {
                  return ids.filter((id) => id !== tier.id);
                } else {
                  return [...ids, tier.id];
                }
              });
            }}
          />
        </td>
      ))}
      <td align="right">
        <Group position="right">
          <Button
            size="xs"
            color="blue"
            disabled={!isDirty}
            variant="outline"
            onClick={handleUpdate}
            loading={isLoading}
            h={24}
          >
            Save
          </Button>
          <Tooltip label="Remove">
            <ActionIcon
              size="sm"
              color="red"
              variant="outline"
              loading={isLoading}
              onClick={handleRemove}
            >
              <IconTrash size={16} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </td>
    </tr>
  );
};
