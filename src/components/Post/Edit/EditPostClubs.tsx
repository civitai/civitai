import { Button, Stack, Text } from '@mantine/core';

import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { useFeatureFlags } from '../../../providers/FeatureFlagsProvider';
import { useMutateClub, useQueryUserContributingClubs } from '../../Club/club.utils';
import { ClubResourceManagementInput } from '../../Club/ClubResourceManagementInput';

export function EditPostClubs() {
  const features = useFeatureFlags();
  const id = useEditPostContext((state) => state.id);
  const { hasClubs } = useQueryUserContributingClubs();
  const { upsertClubResource, upsertingResource } = useMutateClub();

  const clubs = useEditPostContext((state) => state.clubs);
  const setClubs = useEditPostContext((state) => state.setClubs);

  const onSave = async () => {
    await upsertClubResource({ clubs: clubs ?? [], entityId: id, entityType: 'Post' });
  };

  if (!features.clubs || !hasClubs) return null;

  return (
    <Stack mt="lg">
      <Text size="sm" tt="uppercase" weight="bold">
        Make this resource part of a club
      </Text>
      <Text size="xs" color="dimmed">
        This will make this resource available to club members only. People will still see this
        resource in the public list, but will be required to join the club to use it.
      </Text>

      <ClubResourceManagementInput value={clubs} onChange={setClubs} />
      <Button variant="outline" onClick={onSave} loading={upsertingResource}>
        {upsertingResource ? 'Saving...' : 'Save clubs configuration'}
      </Button>
    </Stack>
  );
}
