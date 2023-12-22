import { Button, Checkbox, Stack, Text } from '@mantine/core';

import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { useFeatureFlags } from '../../../providers/FeatureFlagsProvider';
import { useMutateClub, useQueryUserContributingClubs } from '../../Club/club.utils';
import { ClubResourceManagementInput } from '../../Club/ClubResourceManagementInput';
import { trpc } from '../../../utils/trpc';
import { useEffect } from 'react';
import { useRouter } from 'next/router';

export function EditPostClubs() {
  const features = useFeatureFlags();
  const id = useEditPostContext((state) => state.id);
  const router = useRouter();
  const clubId = router.query.clubId ? Number(router.query.clubId) : undefined;

  const { hasClubs, userClubs } = useQueryUserContributingClubs();
  const { upsertClubResource, upsertingResource } = useMutateClub();

  const clubs = useEditPostContext((state) => state.clubs);
  const setClubs = useEditPostContext((state) => state.setClubs);
  const publishedAt = useEditPostContext((state) => state.publishedAt);

  useEffect(() => {
    if (clubId && userClubs?.find((c) => c.id === clubId)) {
      setClubs([{ clubId, clubTierIds: [] }]);
    }
  }, [clubId, userClubs]);

  const onSave = async () => {
    await upsertClubResource({ clubs: clubs ?? [], entityId: id, entityType: 'Post' });
  };

  if (!features.clubs || !hasClubs) return null;

  return (
    <Stack mt="lg">
      <ManagePostUnlistedStatus />
      <Text size="sm" tt="uppercase" weight="bold">
        Make this resource part of a club
      </Text>
      {!publishedAt && (
        <Text size="xs">
          This resource will be posted in the club feed once the post is published on the clubs that
          you have permission to manage club feed posts.
        </Text>
      )}

      <Text size="xs" color="dimmed">
        By adding this resource available to club members only. People will still see this resource
        in the public list, but will be required to join the club to use it.
      </Text>

      <ClubResourceManagementInput value={clubs} onChange={setClubs} />
      <Button variant="outline" onClick={onSave} loading={upsertingResource}>
        {upsertingResource ? 'Saving...' : 'Save clubs configuration'}
      </Button>
    </Stack>
  );
}

export function ManagePostUnlistedStatus() {
  const features = useFeatureFlags();
  const { hasClubs } = useQueryUserContributingClubs();
  const id = useEditPostContext((state) => state.id);
  const unlisted = useEditPostContext((state) => state.unlisted);
  const toggleUnlisted = useEditPostContext((state) => state.toggleUnlisted);

  const { mutate, isLoading } = trpc.post.update.useMutation();

  const toggleCheckbox = () => {
    toggleUnlisted();
    mutate({ id, unlisted: !unlisted }, { onError: () => toggleUnlisted(false) });
  };

  if (!features.clubs || !hasClubs) return null;

  return (
    <>
      <Checkbox
        checked={!unlisted}
        onChange={toggleCheckbox}
        disabled={isLoading}
        label={
          <Stack>
            <Text weight="bold">Visible to everyone</Text>
          </Stack>
        }
      />
      <Text size="xs">
        By marking this visible to everyone, a preview of this post will be displayed in the post
        feed for other users. If you want this post to only be visible to club members, uncheck
        this.
      </Text>
    </>
  );
}
