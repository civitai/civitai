import { ActionIcon, Group, Paper, Stack, Switch, Text, Tooltip } from '@mantine/core';
import {
  IconBox,
  IconFolder,
  IconStack2,
  IconTag,
  IconTrash,
  IconUserCircle,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';

export type HubSourceCardProps = {
  source: {
    type: UserHubSourceType;
    targetId: number;
    alias?: string | null;
    enabled: boolean;
    exclude?: boolean;
    index: number;
  };
  disabled?: boolean;
  /** A hub you do not own — the source list is not yours to change. */
  hideRemove?: boolean;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
};

const sourceMeta: Record<
  UserHubSourceType,
  { label: string; color: string; Icon: typeof IconUserCircle }
> = {
  [UserHubSourceType.User]: { label: 'Creator', color: 'blue', Icon: IconUserCircle },
  [UserHubSourceType.Model]: { label: 'Model', color: 'violet', Icon: IconBox },
  [UserHubSourceType.ModelVersion]: { label: 'Version', color: 'teal', Icon: IconStack2 },
  [UserHubSourceType.Collection]: { label: 'Collection', color: 'orange', Icon: IconFolder },
  [UserHubSourceType.Tag]: { label: 'Tag', color: 'grape', Icon: IconTag },
};

export function HubSourceCard({
  source,
  disabled,
  hideRemove,
  onToggle,
  onRemove,
}: HubSourceCardProps) {
  const { label, color: includeColor, Icon } = sourceMeta[source.type];
  const name = source.alias ?? `#${source.targetId}`;
  const on = source.enabled;
  // One red for every excluded kind, rather than the type's own colour: what the
  // row DOES is the thing to read at a glance, and a red creator chip beside a blue
  // one says it faster than the word does.
  const color = source.exclude ? 'red' : includeColor;

  return (
    <Paper
      withBorder
      radius="md"
      className={clsx('flex items-stretch overflow-hidden pr-2 transition-colors')}
      style={{
        borderColor: on
          ? `var(--mantine-color-${color}-filled)`
          : 'light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))',
      }}
    >
      <div
        aria-hidden
        className="flex w-11 shrink-0 items-center justify-center self-stretch"
        style={{
          backgroundColor: on
            ? `var(--mantine-color-${color}-light)`
            : 'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))',
          color: on ? `var(--mantine-color-${color}-light-color)` : 'var(--mantine-color-dimmed)',
        }}
      >
        <Icon size={22} />
      </div>

      <Group gap="xs" wrap="nowrap" className="min-w-0 flex-1 py-2 pl-2">
        <Stack gap={0} className="min-w-0 flex-1">
          <Text
            size="10px"
            fw={700}
            tt="uppercase"
            lh={1.3}
            c={on ? color : 'dimmed'}
            className="tracking-wide"
          >
            {source.exclude ? `${label} · kept out` : label}
          </Text>
          <Text size="sm" fw={500} lh={1.3} lineClamp={1} c={on ? undefined : 'dimmed'}>
            {name}
          </Text>
        </Stack>
      </Group>

      <Group gap={4} wrap="nowrap" className="shrink-0 self-center">
        <Tooltip
          label={
            source.exclude
              ? on
                ? 'Kept out of this hub'
                : 'Exclusion switched off'
              : on
              ? 'Showing in this hub'
              : 'Hidden from this hub'
          }
        >
          <Switch
            size="xs"
            checked={on}
            disabled={disabled}
            aria-label={`Toggle ${name}`}
            onChange={(event) => onToggle(event.currentTarget.checked)}
          />
        </Tooltip>
        {!hideRemove && (
          <Tooltip label="Remove from hub">
            <ActionIcon
              size="sm"
              variant="subtle"
              color="red"
              disabled={disabled}
              aria-label={`Remove ${name}`}
              onClick={onRemove}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Paper>
  );
}
