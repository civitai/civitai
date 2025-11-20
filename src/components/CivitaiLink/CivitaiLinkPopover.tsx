import type { GroupProps, StackProps } from '@mantine/core';
import {
  Group,
  Popover,
  Stack,
  Text,
  Progress,
  Title,
  Paper,
  Indicator,
  ScrollArea,
  Divider,
  Center,
  Button,
  Tooltip,
  CopyButton,
  ColorSwatch,
  useMantineTheme,
  List,
  defaultVariantColorsResolver,
} from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { showNotification } from '@mantine/notifications';
import {
  IconDownload,
  IconLink,
  IconPlus,
  IconTrash,
  IconX,
  IconSettings,
  IconLinkOff,
  IconCheck,
  IconCopy,
  IconAlertTriangle,
  IconNetworkOff,
  IconScreenShare,
  IconHeart,
  IconVideo,
} from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import {
  civitaiLinkStatusColors,
  useCivitaiLink,
  useCivitaiLinkStore,
} from '~/components/CivitaiLink/CivitaiLinkProvider';
import { CivitaiLinkSvg } from '~/components/CivitaiLink/CivitaiLinkSvg';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { formatBytes, formatSeconds } from '~/utils/number-helpers';
import { titleCase } from '~/utils/string-helpers';
import classes from './CivitaiLinkPopover.module.scss';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const CivitaiLinkWizardModal = dynamic(() => import('~/components/CivitaiLink/CivitaiLinkWizard'), {
  ssr: false,
});
const openCivitaiLinkWizardModal = createDialogTrigger(CivitaiLinkWizardModal);

export function CivitaiLinkPopover() {
  return (
    <Popover
      position="bottom-end"
      width={400}
      zIndex={imageGenerationDrawerZIndex + 1}
      withinPortal
    >
      <Popover.Target>
        <span>
          <LinkButton />
        </span>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <LinkDropdown />
      </Popover.Dropdown>
    </Popover>
  );
}

type HelpStatus = 'pending' | 'processing' | 'complete';
function SupporterHelp() {
  const [status, setStatus] = useState<HelpStatus>('pending');
  const user = useCurrentUser();
  if (!user) return null;

  const refreshSession = () => {
    setStatus('processing');
    showNotification({
      id: 'refresh-session',
      title: 'Refreshing account data...',
      message: 'Fetching fresh data for your account',
      loading: true,
    });
    user.refresh();
    setTimeout(() => {
      showNotification({
        id: 'refresh-session',
        title: 'Account data refreshed!',
        message: 'The data for your account has been updated',
        loading: false,
      });
      setStatus('complete');
    }, 5000);
  };

  if (status === 'processing') {
    return (
      <Text size="xs" ta="center">
        Refreshing your account data...
      </Text>
    );
  } else if (status === 'complete') {
    return (
      <Text size="xs" ta="center" px="xs">
        Oh, no! You are still seeing this...
        <br /> Please check your subscription status and try again.
      </Text>
    );
  }

  return (
    <Text size="xs" ta="center">
      Are you a supporter and seeing this message?{' '}
      <Text
        component="span"
        c="blue.4"
        td="underline"
        onClick={() => refreshSession()}
        style={{ cursor: 'pointer' }}
      >
        Click here
      </Text>
    </Text>
  );
}

function AboutCivitaiLink() {
  return (
    <>
      <AlertWithIcon
        icon={<IconAlertTriangle size={16} />}
        iconColor="yellow"
        radius={0}
        size="md"
        color="yellow"
      >
        This feature is currently in early access and only available to Supporters.
      </AlertWithIcon>
      <SupporterHelp />
      <Stack py="sm" px="lg" gap={4}>
        <Center p="md" pb={0}>
          <CivitaiLinkSvg />
        </Center>
        <Text my="xs">Interact with any Stable Diffusion instance in realtime from Civitai</Text>
      </Stack>
      <Divider />
      <Group gap={0} grow>
        <Button
          leftSection={<IconVideo size={18} />}
          radius={0}
          component="a"
          href="/v/civitai-link-intro"
          variant="light"
        >
          Video Demo
        </Button>
        <Button rightSection={<IconHeart size={18} />} radius={0} component={Link} href="/pricing">
          Become a Supporter
        </Button>
      </Group>
    </>
  );
}

function LinkDropdown() {
  const [manage, setManage] = useState(false);
  const { instance, instances, status, error } = useCivitaiLink();
  const features = useFeatureFlags();
  const notAllowed = !features.civitaiLink;

  const handleManageClick = () => {
    setManage((o) => !o);
  };

  const canToggleManageInstances = !!instances?.length && status !== 'no-selected-instance';

  return (
    <Paper style={{ overflow: 'hidden' }}>
      <Stack gap={0} p="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <Title order={4} size="sm">
              Civitai Link
            </Title>
          </Group>
          {canToggleManageInstances && (
            <Tooltip label="Manage instances">
              <LegacyActionIcon onClick={handleManageClick}>
                <IconSettings size={20} />
              </LegacyActionIcon>
            </Tooltip>
          )}
        </Group>
        {!!instances?.length && (
          <Text c="dimmed" size="xs">
            {instance?.name ?? 'no instance selected'}
          </Text>
        )}
      </Stack>
      <Divider />
      {manage ? (
        <InstancesManager />
      ) : notAllowed ? (
        <AboutCivitaiLink />
      ) : (
        {
          'not-connected': <NotConnected error={error} />,
          'no-socket-connection': <LostConnection error={error} />,
          'no-instances': <GetStarted />,
          'no-selected-instance': <InstancesManager />,
          'link-pending': <GetReconnected />,
          'link-ready': <ActivityList />,
        }[status]
      )}
    </Paper>
  );
}

function NotConnected({ error }: { error?: string }) {
  return (
    <Stack p="xl" align="center" gap={0}>
      <IconNetworkOff size={60} strokeWidth={1} />
      <Text>Cannot Connect</Text>
      <Text
        c="dimmed"
        size="xs"
      >{`We're unable to connect to the Civitai Link Coordination Server.`}</Text>
      {error && (
        <Text c="red" size="xs">
          {error}
        </Text>
      )}
    </Stack>
  );
}

function LostConnection({ error }: { error?: string }) {
  return (
    <Stack p="xl" align="center" gap={0}>
      <IconNetworkOff size={60} strokeWidth={1} />
      <Text>Connection Lost</Text>
      <Text
        c="dimmed"
        size="xs"
      >{`We've lost connect to the Civitai Link Coordination Server.`}</Text>
      {error && (
        <Text c="red" size="xs">
          {error}
        </Text>
      )}
    </Stack>
  );
}

function InstancesManager() {
  const {
    instances,
    instance: selectedInstance,
    deselectInstance,
    deleteInstance,
    selectInstance,
    status,
  } = useCivitaiLink();

  const handleAddClick = () => {
    deselectInstance();
    openCivitaiLinkWizardModal();
  };

  const showControls = status !== 'no-socket-connection';

  return (
    <Stack gap={0}>
      <Group justify="space-between" p="xs">
        <Text fw={500}>Stable Diffusion Instances</Text>
        {showControls && (
          <Button
            size="compact-xs"
            variant="outline"
            leftSection={<IconPlus size={18} />}
            onClick={handleAddClick}
          >
            Add Instance
          </Button>
        )}
      </Group>
      <ScrollArea.Autosize mah={410}>
        {instances?.map((instance) => {
          const isSelected = instance.id === selectedInstance?.id;
          return (
            <Group key={instance.id} className={classes.listItem} justify="space-between" p="xs">
              <Text>{instance.name}</Text>
              <Group gap="xs">
                {isSelected && <BigIndicator />}
                {showControls && (
                  <>
                    {isSelected ? (
                      <Tooltip label="disconnect" withinPortal>
                        <LegacyActionIcon onClick={deselectInstance}>
                          <IconLinkOff size={20} />
                        </LegacyActionIcon>
                      </Tooltip>
                    ) : (
                      <Tooltip label="connect" withinPortal>
                        <LegacyActionIcon onClick={() => selectInstance(instance.id)}>
                          <IconLink size={20} />
                        </LegacyActionIcon>
                      </Tooltip>
                    )}
                    <Tooltip label="delete" withinPortal>
                      <LegacyActionIcon color="red" onClick={() => deleteInstance(instance.id)}>
                        <IconTrash size={20} />
                      </LegacyActionIcon>
                    </Tooltip>
                  </>
                )}
              </Group>
            </Group>
          );
        })}
      </ScrollArea.Autosize>
    </Stack>
  );
}

function BigIndicator() {
  const theme = useMantineTheme();
  const { status } = useCivitaiLink();
  const swatch = defaultVariantColorsResolver({
    variant: 'filled',
    color: civitaiLinkStatusColors[status],
    theme,
  });
  return swatch.background ? <ColorSwatch color={swatch.background} size={20} /> : null;
}

function GetStarted() {
  return (
    <>
      <Stack py="sm" px="lg" gap={4}>
        <Center p="md" pb={0}>
          <CivitaiLinkSvg />
        </Center>
        <Text my="xs">Interact with any Stable Diffusion instance in realtime from Civitai</Text>
      </Stack>
      <Divider />
      <Stack>
        <Button
          leftSection={<IconPlus size={18} />}
          radius={0}
          onClick={() => openCivitaiLinkWizardModal()}
        >
          Get Started
        </Button>
      </Stack>
    </>
  );
}

function GetReconnected() {
  const { instance, createInstance } = useCivitaiLink();
  const handleGenerateKey = () => createInstance(instance?.id ?? undefined);

  return (
    <>
      <AlertWithIcon
        iconColor="yellow"
        icon={<IconAlertTriangle />}
        radius={0}
        size="md"
        color="yellow"
      >{`Couldn't connect to SD instance!`}</AlertWithIcon>
      <Stack p="sm" gap={4}>
        {instance?.key && (
          <Stack gap={0} align="center" mb="md">
            <Text size="md" fw={700}>
              Link Key
            </Text>
            <CopyButton value={instance.key}>
              {({ copied, copy }) => (
                <Tooltip label="Copy" withinPortal>
                  <Button
                    onClick={copy}
                    variant="default"
                    size="lg"
                    px="sm"
                    rightSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  >
                    {!copied ? instance.key : 'Copied'}
                  </Button>
                </Tooltip>
              )}
            </CopyButton>
          </Stack>
        )}
        <Text size="md" fw={500}>
          Troubleshooting
        </Text>
        <List type="unordered">
          <List.Item>Make sure your SD instance is up and running.</List.Item>
          <List.Item>
            If your instance is running and you are still unable to connect,{' '}
            <Text
              c="blue.4"
              display="inline"
              style={{ cursor: 'pointer' }}
              onClick={handleGenerateKey}
            >
              generate a new connection key
            </Text>{' '}
            and add it to your SD instance.
          </List.Item>
        </List>
      </Stack>
    </>
  );
}

function ActivityList() {
  const ids = useCivitaiLinkStore((state) => state.ids);
  return ids.length > 0 ? (
    <ScrollArea.Autosize mah={410}>
      {ids.map((id) => (
        <LinkActivity key={id} id={id} p="xs" pr="sm" className={classes.listItem} />
      ))}
    </ScrollArea.Autosize>
  ) : (
    <Center p="lg">
      <Text c="dimmed">No activity for this instance</Text>
    </Center>
  );
}

function LinkButton() {
  // only show the connected indicator if there are any instances
  const { status } = useCivitaiLink();
  const activityProgress = useCivitaiLinkStore((state) => state.activityProgress);
  const color = civitaiLinkStatusColors[status];

  return (
    <div className="relative">
      <Indicator className="flex items-center" color={color} disabled={!color}>
        <LegacyActionIcon variant="subtle" color="gray">
          <IconScreenShare />
        </LegacyActionIcon>
      </Indicator>
      {activityProgress && activityProgress > 0 && activityProgress < 100 && (
        <Progress
          value={activityProgress}
          striped
          animated
          size="sm"
          style={{ position: 'absolute', bottom: -3, width: '100%' }}
        />
      )}
    </div>
  );
}

function LinkActivity({ id, ...props }: { id: string } & GroupProps) {
  const activity = useCivitaiLinkStore(useCallback((state) => state.activities[id], [id]));
  const { runCommand } = useCivitaiLink();

  const isAdd = activity.type === 'resources:add';
  const isRemove = activity.type === 'resources:remove';

  if (!isAdd && !isRemove) return null;

  const handleCancel = () => {
    runCommand({ type: 'activities:cancel', activityId: activity.id });
  };

  return (
    <Group align="center" wrap="nowrap" gap="xs" {...props}>
      {isAdd ? <IconDownload /> : <IconTrash />}
      <Stack style={{ flex: 1 }} gap={0}>
        <Text lineClamp={1} size="md" fw={500} style={{ lineHeight: 1 }}>
          {activity.resource.modelName || (isAdd ? activity.resource.name : undefined)}
        </Text>
        {isAdd && activity.status === 'processing' ? (
          <RequestProgress
            progress={activity.progress}
            remainingTime={activity.remainingTime}
            speed={activity.speed}
            style={{ flex: 1 }}
            onCancel={handleCancel}
          />
        ) : activity.status === 'error' ? (
          <Text c="red" size="xs">
            {activity.status}: {activity.error}
          </Text>
        ) : (
          <Text c="dimmed" size="xs">
            {activity.status === 'success'
              ? isAdd
                ? 'Downloaded'
                : 'Removed'
              : titleCase(activity.status)}
          </Text>
        )}
      </Stack>
    </Group>
  );
}

function RequestProgress({
  progress,
  remainingTime,
  speed,
  onCancel,
  ...props
}: {
  progress?: number;
  remainingTime?: number;
  speed?: number;
  onCancel: () => void;
} & StackProps) {
  if (!progress && !remainingTime && !speed) return null;

  return (
    <Stack gap={2} {...props}>
      {progress && (
        <Group gap={4}>
          <Progress.Root style={{ width: '100%', flex: 1 }} size="xl">
            <Progress.Section
              value={progress}
              color={progress < 100 ? 'blue' : 'green'}
              striped
              animated
            >
              <Progress.Label>{`${Math.floor(progress)}%`}</Progress.Label>
            </Progress.Section>
          </Progress.Root>
          <LegacyActionIcon onClick={onCancel}>
            <IconX />
          </LegacyActionIcon>
        </Group>
      )}
      {(speed || remainingTime) && (
        <Group justify="space-between">
          {speed ? <Text size="xs" c="dimmed">{`${formatBytes(speed)}/s`}</Text> : <span />}
          {remainingTime ? (
            <Text size="xs" c="dimmed">{`${formatSeconds(remainingTime)} remaining`}</Text>
          ) : (
            <span />
          )}
        </Group>
      )}
    </Stack>
  );
}
