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
  children?: (data: {
    subscribed: boolean;
    isLoading: boolean;
    setSubscribed: (subscribed: boolean) => Promise<void>;
  }) => JSX.Element | null;
}) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const { data: subscription, isLoading } = trpc.newsletter.getSubscription.useQuery();
  const { mutate } = trpc.newsletter.updateSubscription.useMutation({
    async onMutate({ subscribed }) {
      await queryUtils.newsletter.getSubscription.cancel();

      const prev = queryUtils.newsletter.getSubscription.getData();
      queryUtils.newsletter.getSubscription.setData(undefined, (old) => ({
        ...(old ?? {}),
        subscribed,
        showNewsletterDialog: false,
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

  if (children) return children({ subscribed, setSubscribed, isLoading });

  return (
    <Group gap="sm" wrap="nowrap" align="flex-start">
      <Switch
        checked={subscribed}
        disabled={isLoading}
        onChange={({ target }) => setSubscribed(target.checked)}
      />
      <Stack gap={0}>
        <Group gap="sm">
          <Text size="sm">{label ?? 'Newsletter'}</Text>
          <Popover width={300} withArrow withinPortal shadow="sm">
            <Popover.Target>
              <IconInfoSquareRounded size={16} style={{ cursor: 'pointer', opacity: 0.7 }} />
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap="xs">
                <Text size="sm" fw={500}>
                  {`What's the Civitai Newsletter?`}
                </Text>
                <Text size="xs" lh={1.3}>
                  Get model and creator highlights, AI news, as well as comprehensive guides from
                  leaders in the AI Content Universe delivered to your inbox.
                </Text>
                <Text size="xs" lh={1.3}>
                  {`We hate spam as much as you do, so we'll only send you the good stuff.`}
                </Text>
                <Text size="xs" c="dimmed" lh={1.3}>
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
          <Text size="xs" c="dimmed">
            {description}
          </Text>
        )}
      </Stack>
    </Group>
  );
}
