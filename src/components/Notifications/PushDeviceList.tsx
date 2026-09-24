import {
  ActionIcon,
  Badge,
  Divider,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import {
  IconBrandChrome,
  IconBrandEdge,
  IconBrandFirefox,
  IconBrandOpera,
  IconBrandSafari,
  IconDeviceMobile,
  IconTrash,
  IconWorld,
} from '@tabler/icons-react';
import React from 'react';
import dayjs from '~/shared/utils/dayjs';
import { usePushSubscription } from '~/components/Notifications/usePushSubscription';
import { trpc } from '~/utils/trpc';

type DeviceInfo = { browser: string; os: string | null; icon: Icon };

function parseDevice(userAgent: string | null): DeviceInfo {
  if (!userAgent) return { browser: 'Unknown browser', os: null, icon: IconWorld };
  // Order matters: Edge and Opera carry "Chrome" in their UA, Chrome carries "Safari".
  const [browser, icon]: [string, Icon] = /edg\//i.test(userAgent)
    ? ['Edge', IconBrandEdge]
    : /opr\//i.test(userAgent)
    ? ['Opera', IconBrandOpera]
    : /chrome|crios/i.test(userAgent)
    ? ['Chrome', IconBrandChrome]
    : /firefox|fxios/i.test(userAgent)
    ? ['Firefox', IconBrandFirefox]
    : /safari/i.test(userAgent)
    ? ['Safari', IconBrandSafari]
    : ['Browser', IconWorld];
  const os = /windows/i.test(userAgent)
    ? 'Windows'
    : /android/i.test(userAgent)
    ? 'Android'
    : /iphone|ipad/i.test(userAgent)
    ? 'iOS'
    : /mac os/i.test(userAgent)
    ? 'macOS'
    : /linux/i.test(userAgent)
    ? 'Linux'
    : null;
  const mobile = /android|iphone|ipad|mobile/i.test(userAgent);
  return { browser, os, icon: mobile ? IconDeviceMobile : icon };
}

/**
 * Every browser this account receives push in, with per-device revoke. Removing a device deletes
 * its server row, so pushes stop even though that browser's own subscription object lives on —
 * its UI reconciles against the server list the next time it loads.
 */
export function PushDeviceList() {
  const { currentEndpoint, disable } = usePushSubscription();
  const queryUtils = trpc.useUtils();
  // staleTime 0 (app default Infinity): a revoke from another device must show on the next visit.
  const { data: devices = [] } = trpc.notification.getPushSubscriptions.useQuery(undefined, {
    staleTime: 0,
  });
  const unsubscribeMutation = trpc.notification.unsubscribePush.useMutation({
    onSuccess: () => queryUtils.notification.getPushSubscriptions.invalidate(),
  });

  if (devices.length === 0) return null;

  const remove = async (endpoint: string) => {
    if (endpoint === currentEndpoint) {
      // This browser: go through disable() so the browser-side subscription is dropped too.
      await disable();
      await queryUtils.notification.getPushSubscriptions.invalidate();
    } else {
      unsubscribeMutation.mutate({ endpoint });
    }
  };

  return (
    <Stack gap={6}>
      <Text size="xs" c="dimmed" fw={600} tt="uppercase" lts="0.04em">
        Devices receiving push
      </Text>
      <Paper withBorder radius="md">
        {devices.map((device, index) => {
          const isThisDevice = device.endpoint === currentEndpoint;
          const { browser, os, icon: DeviceIcon } = parseDevice(device.userAgent);
          return (
            <React.Fragment key={device.id}>
              {index > 0 && <Divider />}
              <Group justify="space-between" wrap="nowrap" p="sm">
                <Group wrap="nowrap" gap="sm">
                  <ThemeIcon variant="light" color="gray" size="lg" radius="xl">
                    <DeviceIcon size={20} />
                  </ThemeIcon>
                  <Stack gap={2}>
                    <Group gap="xs">
                      <Text size="sm" fw={600}>
                        {browser}
                        {os && (
                          <Text span size="sm" fw={400} c="dimmed">
                            {' '}
                            on {os}
                          </Text>
                        )}
                      </Text>
                      {isThisDevice && (
                        <Badge size="xs" variant="light" color="green">
                          This device
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      Added {dayjs(device.createdAt).format('MMM D, YYYY')}
                      {device.lastSuccessAt
                        ? ` · last push ${dayjs(device.lastSuccessAt).fromNow()}`
                        : ' · no pushes yet'}
                    </Text>
                  </Stack>
                </Group>
                <Tooltip
                  label={isThisDevice ? 'Turn off push on this device' : 'Remove this device'}
                >
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={
                      isThisDevice ? 'Turn off push on this device' : 'Remove this device'
                    }
                    loading={unsubscribeMutation.isPending}
                    onClick={() => remove(device.endpoint)}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </React.Fragment>
          );
        })}
      </Paper>
    </Stack>
  );
}
