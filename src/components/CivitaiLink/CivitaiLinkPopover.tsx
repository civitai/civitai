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
} from '@mantine/core';
import { StackProps } from '@mantine/core/lib/Stack';
import { IconDownload, IconLink, IconPlus, IconTrash, IconX } from '@tabler/icons';
import { useCivitaiLink, useCivitaiLinkStore } from '~/components/CivitaiLink/CivitaiLinkProvider';
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

/*
  - TODO - connected instances
    - if a user doesn't have an active connection, list the connections
    - gear icon ('manage connections') will let the user manage their connections
*/

function LinkDropdown() {
  const { selectedInstance, connected } = useCivitaiLink();
  const ids = useCivitaiLinkStore((state) => state.ids);
  const { classes } = useCivitaiLinkDropdownStyles();
  const hasSelectedInstance = false; // TODO.temp - update references with references to `selectedInstance`
  return (
    <Paper style={{ overflow: 'hidden' }}>
      <Stack spacing={0}>
        <Group position="apart" noWrap p="xs">
          <Title order={4} size="sm">
            Civitai Link
          </Title>
          {/* TODO.civitai-link - enable after adding ability to manage instances */}
          {/* <ActionIcon>
          <IconSettings />
        </ActionIcon> */}
        </Group>
        <Text color="dimmed" size="xs">
          {selectedInstance?.name}
        </Text>
      </Stack>
      <Divider />
      {connected ? (
        <>
          {hasSelectedInstance ? (
            ids.length > 0 ? (
              <ScrollArea.Autosize maxHeight={410}>
                {ids.map((id) => (
                  <LinkActivity key={id} id={id} p="xs" pr="sm" className={classes.linkActivity} />
                ))}
              </ScrollArea.Autosize>
            ) : (
              <Center p="lg">
                <Text color="dimmed">No activity history for this instance</Text>
              </Center>
            )
          ) : (
            <Stack p="xs">
              <Text size="sm">
                Manage your Automatic1111 Stable Diffusion instance right from Civitai. Add and
                remove resources while you browse the site. More to come soon!
              </Text>
            </Stack>
          )}
          {/* TODO.civitai-link - figure out what needs to change for managing multiple instances  */}
          {!hasSelectedInstance && (
            <>
              <Divider />
              <Stack>
                <Button
                  leftIcon={<IconPlus size={18} />}
                  radius={0}
                  onClick={() => openContext('civitai-link-wizard', {})}
                >
                  {hasSelectedInstance ? 'Connect new stable diffusion instance' : 'Get Started'}
                </Button>
              </Stack>
            </>
          )}
        </>
      ) : (
        <Center p="xl">
          <Text color="dimmed">Not connected</Text>
        </Center>
      )}
    </Paper>
  );
}

const useCivitaiLinkDropdownStyles = createStyles((theme) => ({
  linkActivity: {
    '&:nth-of-type(2n + 1)': {
      backgroundColor: theme.colors.dark[6],
    },
  },
}));

function LinkButton() {
  const { connected } = useCivitaiLink();

  return (
    <ActionIcon>
      <Indicator color={connected ? 'green' : 'orange'}>
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
