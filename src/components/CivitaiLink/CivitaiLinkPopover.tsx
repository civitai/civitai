/* eslint-disable react/jsx-no-undef */
import {
  ActionIcon,
  Group,
  Popover,
  Stack,
  Text,
  Progress,
  Title,
  GroupProps,
  Paper,
  Indicator,
  createStyles,
  ScrollArea,
  Divider,
  Center,
  Button,
  Tooltip,
  StackProps,
  Alert,
  CopyButton,
  ColorSwatch,
  useMantineTheme,
  Badge,
} from '@mantine/core';
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
} from '@tabler/icons';
import { useState } from 'react';
import {
  civitaiLinkStatusColors,
  useCivitaiLink,
  useCivitaiLinkStore,
} from '~/components/CivitaiLink/CivitaiLinkProvider';
import { openContext } from '~/providers/CustomModalsProvider';
import { formatBytes, formatSeconds } from '~/utils/number-helpers';
import { titleCase } from '~/utils/string-helpers';

export function CivitaiLinkPopover() {
  return (
    <Popover position="bottom-end" width={400}>
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

function LinkDropdown() {
  const [manage, setManage] = useState(false);
  const { instance, instances, status } = useCivitaiLink();

  const handleManageClick = () => {
    setManage((o) => !o);
  };

  const canToggleManageInstances = !!instances?.length;

  return (
    <Paper style={{ overflow: 'hidden' }}>
      <Stack spacing={0} p="xs">
        <Group position="apart" noWrap>
          <Title order={4} size="sm">
            Civitai Link
          </Title>
          {canToggleManageInstances && (
            <Tooltip label="manage instances">
              <ActionIcon onClick={handleManageClick}>
                <IconSettings size={20} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        {!!instances?.length && (
          <Text color="dimmed" size="xs">
            {instance?.name ?? 'no instance selected'}
          </Text>
        )}
      </Stack>
      <Divider />
      {manage ? (
        <InstancesManager />
      ) : (
        {
          'not-connected': <NotConnected />,
          'no-socket-connection': <LostConnection />,
          'no-instances': <GetStarted />,
          'no-selected-instance': <InstancesManager />,
          'link-pending': <GetReconnected />,
          'link-ready': <ActivityList />,
        }[status]
      )}
    </Paper>
  );
}

function NotConnected() {
  return (
    <Center p="xl">
      <Text color="dimmed">Not connected</Text>
    </Center>
  );
}

function LostConnection() {
  return (
    <Center p="xl">
      <Text color="dimmed">Lost Connection</Text>
    </Center>
  );
}

function InstancesManager() {
  const { classes } = useStyles();

  const {
    instances,
    instance: selectedInstance,
    deselectInstance,
    selectInstance,
    status,
  } = useCivitaiLink();

  const handleAddClick = () => {
    // deselectInstance();
    openContext('civitai-link-wizard', {});
  };

  const showControls = status !== 'no-socket-connection';

  return (
    <Stack spacing={0}>
      <Group position="apart" p="xs">
        <Text weight={500}>Stable Diffusion Instances</Text>
        {showControls && (
          <Button compact leftIcon={<IconPlus size={18} />} onClick={handleAddClick}>
            Add Instance
          </Button>
        )}
      </Group>
      <ScrollArea.Autosize maxHeight={410}>
        {instances?.map((instance) => {
          const isSelected = instance.id === selectedInstance?.id;
          return (
            <Group key={instance.id} className={classes.listItem} position="apart" p="xs">
              <Text>{instance.name}</Text>
              <Group spacing="xs">
                {isSelected && <BigIndicator />}
                {showControls && (
                  <>
                    {isSelected ? (
                      <Tooltip label="disconnect" withinPortal>
                        <ActionIcon onClick={deselectInstance}>
                          <IconLinkOff size={20} />
                        </ActionIcon>
                      </Tooltip>
                    ) : (
                      <Tooltip label="connect" withinPortal>
                        <ActionIcon onClick={() => selectInstance(instance.id)}>
                          <IconLink size={20} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    <Tooltip label="delete" withinPortal>
                      <ActionIcon color="red">
                        <IconTrash size={20} />
                      </ActionIcon>
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
  const swatch = theme.fn.variant({
    variant: 'filled',
    primaryFallback: false,
    color: civitaiLinkStatusColors[status],
  });
  return swatch.background ? <ColorSwatch color={swatch.background} size={20} /> : null;
}

function GetStarted() {
  return (
    <>
      <Stack p="xs">
        <Text size="sm">
          Manage your Automatic1111 Stable Diffusion instance right from Civitai. Add and remove
          resources while you browse the site. More to come soon!
        </Text>
      </Stack>
      <Divider />
      <Stack>
        <Button
          leftIcon={<IconPlus size={18} />}
          radius={0}
          onClick={() => openContext('civitai-link-wizard', {})}
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
    <Stack p="xs" spacing="xs">
      <Alert color="yellow">{`Couldn't connect to SD instance!`}</Alert>
      <Title size="sm">Troubleshooting</Title>
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        <li>Make sure your SD instance is up and running.</li>
        <li>
          <Text>
            If your instance is running and you are still unable to connect,{' '}
            <Text
              variant="link"
              display="inline"
              style={{ cursor: 'pointer' }}
              onClick={handleGenerateKey}
            >
              generate a new connection key
            </Text>{' '}
            and add it to your SD instance.
          </Text>
        </li>
      </ul>
      {instance?.key && (
        <Center pb="md">
          <Stack spacing={0}>
            <Text size="xs" align="center" weight={500}>
              KEY
            </Text>
            <CopyButton value={instance.key}>
              {({ copied, copy }) => (
                <Tooltip label="Copy" withinPortal>
                  <Badge
                    onClick={copy}
                    color="violet"
                    size="lg"
                    rightSection={
                      <Center>{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}</Center>
                    }
                    sx={{ textTransform: 'none', cursor: 'pointer' }}
                  >
                    {!copied ? instance.key : 'Copied'}
                  </Badge>
                </Tooltip>
              )}
            </CopyButton>
          </Stack>
        </Center>
      )}
    </Stack>
  );
}

function ActivityList() {
  const ids = useCivitaiLinkStore((state) => state.ids);
  const { classes } = useStyles();
  return ids.length > 0 ? (
    <ScrollArea.Autosize maxHeight={410}>
      {ids.map((id) => (
        <LinkActivity key={id} id={id} p="xs" pr="sm" className={classes.listItem} />
      ))}
    </ScrollArea.Autosize>
  ) : (
    <Center p="lg">
      <Text color="dimmed">No activity for this instance</Text>
    </Center>
  );
}

const useStyles = createStyles((theme) => ({
  listItem: {
    '&:nth-of-type(2n + 1)': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    },
  },
}));

function LinkButton() {
  // only show the connected indicator if there are any instances
  const { status } = useCivitaiLink();
  const color = civitaiLinkStatusColors[status];

  return (
    <ActionIcon>
      <Indicator color={color} showZero={!!color} dot={!!color}>
        <IconLink />
      </Indicator>
    </ActionIcon>
  );
}

function LinkActivity({ id, ...props }: { id: string } & GroupProps) {
  const activity = useCivitaiLinkStore((state) => state.activities[id]);
  const { runCommand } = useCivitaiLink();

  const isAdd = activity.type === 'resources:add';
  const isRemove = activity.type === 'resources:remove';

  if (!isAdd && !isRemove) return null;

  const handleCancel = () => {
    runCommand({ type: 'activities:cancel', activityId: activity.id });
  };

  return (
    <Group align="center" noWrap spacing="xs" {...props}>
      {isAdd ? <IconDownload /> : <IconTrash />}
      <Stack style={{ flex: 1 }} spacing={0}>
        <Text lineClamp={1} size="md" weight={500} style={{ lineHeight: 1 }}>
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
          <Text color="red" size="xs">
            {activity.status}: {activity.error}
          </Text>
        ) : (
          <Text color="dimmed" size="xs">
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
    <Stack spacing={2} {...props}>
      {progress && (
        <Group spacing={4}>
          <Progress
            sx={{ width: '100%', flex: 1 }}
            size="xl"
            value={progress}
            label={`${Math.floor(progress)}%`}
            color={progress < 100 ? 'blue' : 'green'}
            striped
            animate
          />
          <ActionIcon onClick={onCancel}>
            <IconX />
          </ActionIcon>
        </Group>
      )}
      {(speed || remainingTime) && (
        <Group position="apart">
          {speed ? <Text size="xs" color="dimmed">{`${formatBytes(speed)}/s`}</Text> : <span />}
          {remainingTime ? (
            <Text size="xs" color="dimmed">{`${formatSeconds(remainingTime)} remaining`}</Text>
          ) : (
            <span />
          )}
        </Group>
      )}
    </Stack>
  );
}
