import { Button, CloseButton, Popover, Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useServerDomains } from '~/providers/AppProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { BuzzBoltSvg } from '~/components/User/BuzzBoltSvg';
import { abbreviateNumber } from '~/utils/number-helpers';

const ALERT_ID = 'yellow-buzz-migration';

/**
 * Floating popover card that wraps children (e.g. UserMenu) and shows
 * a Yellow Buzz migration notice anchored below them.
 */
export function YellowBuzzMigrationNotice({ children }: { children: React.ReactNode }) {
  const currentUser = useCurrentUser();
  const { isGreen, buzz } = useFeatureFlags();
  const serverDomains = useServerDomains();

  const enabled = !!currentUser && isGreen && buzz;
  const { data: buzzAccounts, isLoading: buzzLoading } = trpc.buzz.getBuzzAccount.useQuery(
    undefined,
    { enabled }
  );
  const { data: settings, isLoading: settingsLoading } = trpc.user.getSettings.useQuery(
    undefined,
    { enabled }
  );
  const isDismissed = (settings?.dismissedAlerts ?? []).includes(ALERT_ID);

  const utils = trpc.useUtils();
  const dismissMutation = trpc.user.dismissAlert.useMutation({
    onMutate: async () => {
      await utils.user.getSettings.cancel();
      const prev = utils.user.getSettings.getData();
      utils.user.getSettings.setData(undefined, (old) => ({
        ...old,
        dismissedAlerts: [...(old?.dismissedAlerts ?? []), ALERT_ID],
      }));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.user.getSettings.setData(undefined, ctx.prev);
    },
  });

  const yellowBalance = buzzAccounts?.yellow ?? 0;
  const show = enabled && !buzzLoading && !settingsLoading && !isDismissed && yellowBalance > 0;

  const redDomain = serverDomains.red;
  const syncParams = 'sync-account=green&sync-redirect=%2Fuser%2Fbuzz-dashboard';
  const redUrl = redDomain
    ? `//${redDomain}/?${syncParams}`
    : `https://civitai.red/?${syncParams}`;

  const handleDismiss = () => dismissMutation.mutate({ alertId: ALERT_ID });

  return (
    <Popover
      width={280}
      position="bottom-end"
      shadow="lg"
      opened={show}
      withArrow
      arrowSize={10}
    >
      <Popover.Target>
        <div className="inline-flex">{children}</div>
      </Popover.Target>
      <Popover.Dropdown className="border border-yellow-9/30 p-0">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <BuzzBoltSvg size={18} color="#f59f00" fill="#f59f00" />
              <Text size="sm" fw={600} style={{ color: '#f59f00' }}>
                Yellow Buzz has moved
              </Text>
            </div>
            <CloseButton
              size="xs"
              variant="subtle"
              color="gray"
              radius="xl"
              onClick={handleDismiss}
              aria-label="Dismiss"
              className="shrink-0"
            />
          </div>

          <Text size="xs" c="dimmed" lh={1.4}>
            Your{' '}
            <Text span fw={600} style={{ color: '#f59f00' }}>
              {abbreviateNumber(yellowBalance, { floor: true })} Yellow Buzz
            </Text>{' '}
            is now on{' '}
            <Text span fw={600} className="text-red-4">
              civitai.red
            </Text>
            . Same account, ready to use.
          </Text>

          <Button
            component="a"
            href={redUrl}
            target="_blank"
            rel="noreferrer nofollow"
            variant="light"
            color="red"
            size="compact-xs"
            radius="xl"
            rightSection={<IconArrowRight size={12} />}
            className="self-start"
          >
            View on civitai.red
          </Button>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
