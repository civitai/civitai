import { Stack, Switch, Group, Text, Popover } from '@mantine/core';
import { IconInfoSquareRounded } from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showSuccessNotification } from '~/utils/notifications';

import { trpc } from '~/utils/trpc';

export function NewsletterToggle({
  children,
  label,
  description,
}: {
  label?: string;
  description?: string;
  children?: ({
    subscribed,
    setSubscribed,
  }: {
    subscribed: boolean;
    setSubscribed: (subscribed: boolean) => Promise<void>;
  }) => JSX.Element | null;
}) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();
  const { data: subscription, isLoading } = trpc.newsletter.getSubscription.useQuery();
  const { mutate } = trpc.newsletter.updateSubscription.useMutation({
    async onMutate({ subscribed }) {
      await queryUtils.newsletter.getSubscription.cancel();

      const prev = queryUtils.newsletter.getSubscription.getData();
      queryUtils.newsletter.getSubscription.setData(undefined, (old) => ({
        ...(old ?? {}),
        subscribed,
      }));

      return { prev };
    },
    onSuccess() {
      showSuccessNotification({ message: 'User profile updated' });
    },
    onError(_error, _variables, context) {
      if (context?.prev) queryUtils.newsletter.getSubscription.setData(undefined, context.prev);
    },
  });

  if (!currentUser) return null;
  const subscribed = subscription?.subscribed ?? false;
  const setSubscribed = async (subscribed: boolean) => {
    mutate({ subscribed });
  };

  if (children) return children({ subscribed, setSubscribed });

  return (
    <Group spacing="sm" noWrap align="flex-start">
      <Switch
        checked={subscribed}
        disabled={isLoading}
        onChange={({ target }) => setSubscribed(target.checked)}
      />
      <Stack spacing={0}>
        <Group spacing="sm">
          <Text size="sm">{label ?? 'Newsletter'}</Text>
          <Popover width={300} withArrow withinPortal shadow="sm">
            <Popover.Target>
              <IconInfoSquareRounded size={16} style={{ cursor: 'pointer', opacity: 0.7 }} />
            </Popover.Target>
            <Popover.Dropdown>
              <Stack spacing="xs">
                <Text size="sm" weight={500}>
                  {`What's the Civitai Newsletter?`}
                </Text>
                <Text size="xs" lh={1.3}>
                  Get model and creator highlights, AI news, as well as comprehensive guides from
                  leaders in the AI Content Universe delivered to your inbox.
                </Text>
                <Text size="xs" lh={1.3}>
                  {`We hate spam as much as you do, so we'll only send you the good stuff.`}
                </Text>
                <Text size="xs" color="dimmed" lh={1.3}>
                  Emails will be sent to{' '}
                  <Text component="span" td="underline">
                    {currentUser.email}
                  </Text>
                </Text>
              </Stack>
            </Popover.Dropdown>
          </Popover>
        </Group>
        {description && (
          <Text size="xs" color="dimmed">
            {description}
          </Text>
        )}
      </Stack>
    </Group>
  );
}
