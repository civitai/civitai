import { Stack, Switch, Group, Text, Popover, Card, CardProps, createStyles } from '@mantine/core';
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
    setSubscribed: (subscribed: boolean, email?: string) => Promise<void>;
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
  const setSubscribed = async (subscribed: boolean, email?: string) => {
    mutate({ subscribed, email });
  };

  if (children) return children({ subscribed, setSubscribed, isLoading });

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

export function NewsletterCallout({
  email,
  disabled,
  ...cardProps
}: Omit<CardProps, 'children'> & { email?: string; disabled?: boolean }) {
  const { classes } = useStyles();

  return (
    <Card className={classes.newsletterCard} withBorder {...cardProps}>
      <Card.Section withBorder inheritPadding py="xs">
        <Group position="apart">
          <Text weight={500}>Send me the Civitai Newsletter!</Text>
          <NewsletterToggle>
            {({ subscribed, setSubscribed, isLoading: subscriptionLoading }) => (
              <Switch
                disabled={disabled || subscriptionLoading}
                checked={subscribed}
                onChange={({ target }) => setSubscribed(target.checked, email)}
              />
            )}
          </NewsletterToggle>
        </Group>
      </Card.Section>
      <Text lh={1.3} mt="xs">
        Biweekly updates on industry news, new Civitai features, trending resources, community
        contests, and more!
      </Text>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/images/newsletter-banner.png"
        alt="Robot holding a newspaper"
        className={classes.newsletterBot}
      />
    </Card>
  );
}

const useStyles = createStyles((theme) => ({
  newsletterCard: {
    position: 'relative',
    overflow: 'visible',
    borderColor: theme.colors.blue[5],
    marginTop: 60,
    [theme.fn.largerThan('sm')]: {
      marginTop: 70,
    },

    '&::before': {
      content: '""',
      position: 'absolute',
      left: '-3px',
      top: '-3px',
      background: theme.fn.linearGradient(
        10,
        theme.colors.blue[9],
        theme.colors.blue[7],
        theme.colors.blue[5],
        theme.colors.cyan[9],
        theme.colors.cyan[7],
        theme.colors.cyan[5]
      ),
      backgroundSize: '200%',
      borderRadius: theme.radius.sm,
      width: 'calc(100% + 6px)',
      height: 'calc(100% + 6px)',
      filter: 'blur(4px)',
      zIndex: -1,
      animation: 'glowing 20s linear infinite',
      transition: 'opacity .3s ease-in-out',
    },
  },
  newsletterBot: {
    objectPosition: 'top',
    objectFit: 'cover',
    position: 'absolute',
    top: -100,
    right: 0,
    width: 200,
    zIndex: -1,
  },
}));
