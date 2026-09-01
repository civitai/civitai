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
  Center,
  CopyButton,
  Button,
  Tooltip,
  List,
  Menu,
  TextInput,
} from '@mantine/core';
import clsx from 'clsx';
import classes from './civitai-link.module.scss';
import { AppRow } from '~/components/CivitaiLink/CivitaiLinkAppRow';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { showNotification } from '@mantine/notifications';
import {
  IconChevronLeft,
  IconBoxMultiple,
  IconCheck,
  IconCopy,
  IconDeviceDesktop,
  IconDotsVertical,
  IconPencil,
  IconDownload,
  IconWorld,
  IconPlus,
  IconTrash,
  IconX,
  IconLinkOff,
  IconAlertTriangle,
  IconInfoCircle,
  IconNetworkOff,
  IconScreenShare,
  IconHeart,
  IconPlayerPlay,
  IconRefresh,
} from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import {
  civitaiLinkStatusColors,
  useCivitaiLink,
  useCivitaiLinkStore,
} from '~/components/CivitaiLink/CivitaiLinkProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { formatBytes, formatSeconds } from '~/utils/number-helpers';
import { titleCase } from '~/utils/string-helpers';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const CivitaiLinkWizardModal = dynamic(() => import('~/components/CivitaiLink/CivitaiLinkWizard'), {
  ssr: false,
});
const openCivitaiLinkWizardModal = createDialogTrigger(CivitaiLinkWizardModal);

export function CivitaiLinkPopover() {
  const [opened, setOpened] = useState(false);

  return (
    <Popover
      position="bottom-end"
      width={400}
      zIndex={imageGenerationDrawerZIndex + 1}
      withinPortal
      opened={opened}
      onChange={setOpened}
    >
      <LinkButton onToggle={() => setOpened((o) => !o)} />
      <Popover.Dropdown p={0}>
        <LinkDropdown onClose={() => setOpened(false)} />
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

function Chip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <Group
      gap={6}
      wrap="nowrap"
      px={10}
      py={6}
      className={classes.surface}
      style={{ borderRadius: 999 }}
    >
      {icon}
      <Text fz={11} fw={500} c="var(--mantine-color-text)">
        {label}
      </Text>
    </Group>
  );
}

function LinkPitchArt() {
  return (
    <Group gap={12} justify="center" align="center">
      <Center
        w={52}
        h={52}
        bg="var(--mantine-color-blue-light)"
        style={{ borderRadius: 'var(--mantine-radius-md)' }}
      >
        <IconWorld size={24} className={classes.accentIcon} />
      </Center>
      <Group gap={5}>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={clsx('size-1 rounded-full', classes.dot)} />
        ))}
      </Group>
      <Center
        w={52}
        h={52}
        className={classes.surface}
        style={{ borderRadius: 'var(--mantine-radius-md)' }}
      >
        <IconDeviceDesktop size={24} className={classes.neutralIcon} />
      </Center>
    </Group>
  );
}

function LinkPitch({ children }: { children?: React.ReactNode }) {
  return (
    <Stack pt="lg" pb="md" px="lg" gap="sm" align="center">
      <LinkPitchArt />
      <Text fw={600} ta="center" mt={4}>
        Send models straight to your machine
      </Text>
      <Text size="xs" c="dimmed" ta="center">
        {children ??
          `One click on any model page and it lands in the app you generate with — no downloading, no moving files.`}
      </Text>
      <Group gap={8} justify="center" mt={4}>
        <Chip
          icon={<IconBoxMultiple size={13} className={classes.dimIcon} />}
          label="ComfyUI node pack"
        />
        <Chip
          icon={<IconDeviceDesktop size={13} className={classes.dimIcon} />}
          label="Link desktop app"
        />
      </Group>
    </Stack>
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
        Civitai Link is a Supporter feature, still in early access.
      </AlertWithIcon>
      <SupporterHelp />
      <LinkPitch>
        Supporters get one-click sending to the ComfyUI node pack or the Link desktop app.
      </LinkPitch>
      <Group gap={0} grow>
        <Button
          leftSection={<IconPlayerPlay size={18} />}
          radius={0}
          component="a"
          href="/v/civitai-link-intro"
          variant="light"
        >
          See how it works
        </Button>
        <Button rightSection={<IconHeart size={18} />} radius={0} component={Link} href="/pricing">
          Become a Supporter
        </Button>
      </Group>
    </>
  );
}

function AppHeader({ onBack, showBack }: { onBack: () => void; showBack: boolean }) {
  const { instance, status, deselectInstance, deleteInstance, renameInstance } = useCivitaiLink();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');

  if (!instance?.id) return null;

  const instanceId = instance.id;

  const commitRename = () => {
    const name = draft.trim();
    if (name && name !== instance.name) renameInstance(instanceId, name);
    setRenaming(false);
  };

  return (
    <Group justify="space-between" wrap="nowrap" gap="xs" px="xs" pt="xs" pb={4}>
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
        {showBack && (
          <Tooltip label="All apps" withinPortal>
            <LegacyActionIcon onClick={onBack} aria-label="All apps">
              <IconChevronLeft size={20} />
            </LegacyActionIcon>
          </Tooltip>
        )}
        {renaming ? (
          <TextInput
            size="xs"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            style={{ flex: 1 }}
          />
        ) : (
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Title order={4} size="sm" lineClamp={1}>
              {instance.name}
            </Title>
            <Text c="dimmed" size="xs">
              {status === 'link-ready' ? 'Connected' : 'Not connected'}
            </Text>
          </Stack>
        )}
      </Group>
      {/* Not portaled: a portaled dropdown counts as a click OUTSIDE the
          controlled Popover, which closes the whole thing on first click. */}
      <Menu position="bottom-end" withinPortal={false}>
        <Menu.Target>
          <LegacyActionIcon aria-label="App actions">
            <IconDotsVertical size={20} />
          </LegacyActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconPencil size={16} />}
            onClick={() => {
              setDraft(instance.name ?? '');
              setRenaming(true);
            }}
          >
            Rename
          </Menu.Item>
          <Menu.Item leftSection={<IconLinkOff size={16} />} onClick={deselectInstance}>
            Disconnect
          </Menu.Item>
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={16} />}
            onClick={() => {
              deleteInstance(instanceId);
              onBack();
            }}
          >
            Remove app
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

function LinkDropdown({ onClose }: { onClose: () => void }) {
  const [showList, setShowList] = useState(false);
  const { instance, status, error, deselectInstance } = useCivitaiLink();
  const features = useFeatureFlags();
  const notAllowed = !features.civitaiLink;

  const inAppView = !notAllowed && !!instance?.id && !showList;
  const inListView = !notAllowed && (showList || status === 'no-selected-instance');

  const handleAddClick = () => {
    deselectInstance();
    onClose();
    openCivitaiLinkWizardModal();
  };

  return (
    <Paper style={{ overflow: 'hidden' }}>
      {inAppView ? (
        <AppHeader onBack={() => setShowList(true)} showBack />
      ) : (
        <Group justify="space-between" wrap="nowrap" px="xs" pt="xs" pb={4}>
          <Title order={4} size="sm">
            {inListView ? 'Connected apps' : 'Civitai Link'}
          </Title>
          {inListView && status !== 'no-socket-connection' && (
            <Button
              size="compact-xs"
              variant="outline"
              leftSection={<IconPlus size={18} />}
              onClick={handleAddClick}
            >
              Add app
            </Button>
          )}
        </Group>
      )}
      {notAllowed ? (
        <AboutCivitaiLink />
      ) : showList ? (
        <InstancesManager onSelect={() => setShowList(false)} />
      ) : (
        {
          'not-connected': <NotConnected error={error} />,
          'no-socket-connection': <LostConnection error={error} />,
          'no-instances': <GetStarted onClose={onClose} />,
          'no-selected-instance': <InstancesManager onSelect={() => setShowList(false)} />,
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

function InstancesManager({ onSelect }: { onSelect: () => void }) {
  const { instances, instance: selectedInstance, selectInstance, status } = useCivitaiLink();

  return (
    <Stack gap={0}>
      <ScrollArea.Autosize mah={410}>
        <Stack gap={6} px="xs" py={6}>
          {instances?.map((instance) => (
            <AppRow
              key={instance.id}
              name={instance.name ?? 'Unnamed app'}
              connected={instance.id === selectedInstance?.id && status === 'link-ready'}
              onClick={() => {
                selectInstance(instance.id);
                onSelect();
              }}
            />
          ))}
        </Stack>
      </ScrollArea.Autosize>
      <Group gap="xs" align="flex-start" wrap="nowrap" px="xs" pb="xs" pt={4}>
        <IconInfoCircle size={14} className="mt-0.5 shrink-0 opacity-60" />
        <Text size="xs" c="dimmed">
          Sending goes to the app marked Connected.
        </Text>
      </Group>
    </Stack>
  );
}

function GetStarted({ onClose }: { onClose: () => void }) {
  const handleSetupClick = () => {
    onClose();
    openCivitaiLinkWizardModal();
  };

  return (
    <>
      <LinkPitch />
      <Stack>
        <Button
          leftSection={<IconPlus size={16} />}
          radius={0}
          size="md"
          fullWidth
          onClick={handleSetupClick}
        >
          Set up Civitai Link
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
      <Group
        align="flex-start"
        wrap="nowrap"
        gap={9}
        px={14}
        py={10}
        bg="var(--mantine-color-yellow-light)"
      >
        <IconAlertTriangle size={15} className="mt-0.5 shrink-0 text-yellow-6" />
        <Text fz={11} c="var(--mantine-color-text)" lh={1.5}>
          {`${instance?.name ?? 'This app'} hasn't checked in. Sending is paused until it's back.`}
        </Text>
      </Group>
      {instance?.key && (
        <Stack align="center" gap={6} px="xs" pt="sm">
          <Text fz={11} c="dimmed">
            Pair with this code
          </Text>
          <CopyButton value={instance.key}>
            {({ copied, copy }) => (
              <Tooltip label="Copy" withinPortal>
                <Button
                  variant="default"
                  onClick={copy}
                  px="sm"
                  rightSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                >
                  {!copied ? instance.key : 'Copied'}
                </Button>
              </Tooltip>
            )}
          </CopyButton>
        </Stack>
      )}
      <Stack px="xs" py="sm" gap={6}>
        <Text size="sm" fw={500}>
          Try this
        </Text>
        <List type="unordered" size="xs" spacing={6} c="dimmed">
          <List.Item>Make sure the app is running on that machine.</List.Item>
          <List.Item>{`Open its Civitai Link panel and check it's still paired.`}</List.Item>
          <List.Item>{`Still stuck? Reconnect for a fresh code, then paste it into the app.`}</List.Item>
        </List>
      </Stack>
      <Button
        leftSection={<IconRefresh size={18} />}
        radius={0}
        fullWidth
        onClick={handleGenerateKey}
      >
        Reconnect
      </Button>
    </>
  );
}

function ActivityList() {
  const ids = useCivitaiLinkStore((state) => state.ids);
  const { runCommand } = useCivitaiLink();

  if (!ids.length)
    return (
      <Center p="lg">
        <Text c="dimmed">No activity for this app</Text>
      </Center>
    );

  return (
    <>
      <ScrollArea.Autosize mah={410}>
        {ids.map((id) => (
          <LinkActivity key={id} id={id} px={14} py={12} />
        ))}
      </ScrollArea.Autosize>
      <Group justify="flex-end" px="xs" pb="xs" pt={4}>
        <Text
          size="xs"
          c="blue.4"
          style={{ cursor: 'pointer' }}
          onClick={() => runCommand({ type: 'activities:clear' })}
        >
          Clear activity
        </Text>
      </Group>
    </>
  );
}

// Mantine only wires the target's click handler when the Popover is
// uncontrolled (`PopoverTarget`: `...!ctx.controlled ? { onClick: ctx.onToggle }`),
// so a controlled Popover has to toggle itself.
function LinkButton({ onToggle }: { onToggle: () => void }) {
  // only show the connected indicator if there are any instances
  const { status } = useCivitaiLink();
  const activityProgress = useCivitaiLinkStore((state) => state.activityProgress);
  const color = civitaiLinkStatusColors[status];

  return (
    <div className="relative">
      <Indicator className="flex items-center" color={color} disabled={!color}>
        <Popover.Target>
          <LegacyActionIcon
            variant="subtle"
            color="gray"
            aria-label="Civitai Link"
            onClick={onToggle}
          >
            <IconScreenShare />
          </LegacyActionIcon>
        </Popover.Target>
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
    <Group align="center" wrap="nowrap" gap={12} {...props}>
      <Center
        w={40}
        h={40}
        className={classes.surfaceRaised}
        style={{ borderRadius: 'var(--mantine-radius-sm)', flexShrink: 0 }}
      >
        {isAdd ? (
          <IconDownload size={16} className={classes.dimIcon} />
        ) : (
          <IconTrash size={16} className={classes.dimIcon} />
        )}
      </Center>
      <Stack style={{ flex: 1, minWidth: 0 }} gap={5}>
        <Text lineClamp={1} fz="sm" fw={500} c="var(--mantine-color-bright)">
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
