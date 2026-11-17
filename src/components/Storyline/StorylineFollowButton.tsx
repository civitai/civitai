import { Button } from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
import { IconBell, IconBellCheck, IconCheck } from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { StorylineFollowScope } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const SCOPES: { value: StorylineFollowScope; label: string; description: string }[] = [
  { value: 'Canon', label: 'Canon only', description: 'Chapters on the main path' },
  {
    value: 'Endorsed',
    label: 'Endorsed creators',
    description: 'Also chapters by the owner and collaborators',
  },
  { value: 'Everything', label: 'Everything', description: 'Every new chapter' },
];

/** Follow a storyline for its new chapters, at a scope; owners and collaborators start followed. */
export function StorylineFollowButton({ storylineId }: { storylineId: number }) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const { data } = trpc.storyline.getFollow.useQuery(
    { id: storylineId },
    { enabled: !!currentUser }
  );
  const onError = (error: { message: string }) =>
    showErrorNotification({
      title: "Couldn't update your follow",
      error: new Error(error.message),
    });
  const onSuccess = () => utils.storyline.getFollow.invalidate({ id: storylineId });
  const follow = trpc.storyline.follow.useMutation({ onSuccess, onError });
  const unfollow = trpc.storyline.unfollow.useMutation({ onSuccess, onError });

  if (!currentUser) return null;
  const scope = data?.scope ?? null;
  const loading = follow.isPending || unfollow.isPending;

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <Button
          variant={scope ? 'light' : 'default'}
          size="lg"
          loading={loading}
          className="grow basis-[140px] sm:grow-0 sm:basis-auto"
          leftSection={scope ? <IconBellCheck size={18} /> : <IconBell size={18} />}
        >
          {scope ? 'Following' : 'Follow'}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Tell me about new chapters</Menu.Label>
        {SCOPES.map((option) => (
          <Menu.Item
            key={option.value}
            rightSection={scope === option.value ? <IconCheck size={14} /> : null}
            onClick={() => follow.mutate({ storylineId, scope: option.value })}
          >
            <div className="text-sm">{option.label}</div>
            <div className="text-dimmed text-xs">{option.description}</div>
          </Menu.Item>
        ))}
        {scope && (
          <>
            <Menu.Divider />
            <Menu.Item color="red" onClick={() => unfollow.mutate({ id: storylineId })}>
              Unfollow
            </Menu.Item>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
