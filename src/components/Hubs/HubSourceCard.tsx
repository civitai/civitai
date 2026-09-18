import { ActionIcon, Badge, Group, Paper, Stack, Switch, Text, Tooltip } from '@mantine/core';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import {
  IconBox,
  IconFolder,
  IconStack2,
  IconTag,
  IconTagOff,
  IconTrash,
  IconUserCircle,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { groupRule } from '~/components/Hubs/hub.utils';
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
  /**
   * The rest of this tag AND-group, beyond `source`. Empty or absent for every other
   * kind of source, and for a tag that is a group of one.
   */
  extraTags?: { targetId: number; alias?: string | null }[];
  /** Remove one tag from the hub. Absent when the group is not the viewer's to edit. */
  onRemoveTag?: (targetId: number) => void;
  /** The add-another-tag affordance. Rendered by the editor, which owns the picker. */
  addControl?: React.ReactNode;
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
  extraTags,
  onRemoveTag,
  addControl,
  disabled,
  hideRemove,
  onToggle,
  onRemove,
}: HubSourceCardProps) {
  const { label, color: includeColor, Icon: IncludeIcon } = sourceMeta[source.type];
  const name = source.alias ?? `#${source.targetId}`;
  const on = source.enabled;
  // One red for every excluded kind, rather than the type's own colour: what the
  // row DOES is the thing to read at a glance, and a red creator chip beside a blue
  // one says it faster than the word does.
  const color = source.exclude ? 'red' : includeColor;
  const isTag = source.type === UserHubSourceType.Tag;
  const Icon = isTag && source.exclude ? IconTagOff : IncludeIcon;

  const tags = [{ targetId: source.targetId, alias: source.alias }, ...(extraTags ?? [])];
  const grouped = tags.length > 1;

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
        <Stack gap={grouped ? 4 : 0} className="min-w-0 flex-1">
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
          {grouped ? (
            <>
              <Group gap={4}>
                {tags.map((tag) => (
                  <Badge
                    key={tag.targetId}
                    size="sm"
                    variant="light"
                    color={on ? color : 'gray'}
                    className="max-w-full normal-case"
                    // `styles`, not a className: Mantine's own
                    // `.section[data-position='right']` margin outranks a single
                    // utility class, so the gap left of the X survives `ml-0`.
                    // The button carries its own internal padding, so the chip needs
                    // none of its own on that side.
                    styles={{ root: { paddingRight: 0 }, section: { marginLeft: 0 } }}
                    rightSection={
                      onRemoveTag && (
                        <LegacyActionIcon
                          size="xs"
                          radius="xl"
                          variant="transparent"
                          color={on ? color : 'gray'}
                          aria-label={`Remove ${tag.alias ?? tag.targetId} from this hub`}
                          // NOT `disabled` while a save is in flight: Mantine paints a
                          // disabled ActionIcon with a solid grey block, which reads as
                          // a rendering fault on a chip this small. Guarded in the
                          // handler instead, so the double-submit is still refused.
                          onClick={() => !disabled && onRemoveTag(tag.targetId)}
                        >
                          <IconX size={12} />
                        </LegacyActionIcon>
                      )
                    }
                  >
                    {tag.alias ?? `#${tag.targetId}`}
                  </Badge>
                ))}
              </Group>
              {/* Include groups say nothing: a row of chips reads as "all of these"
                  on its own, and Justin cut the label after seeing it rendered. The
                  EXCLUDE line stays, because that side means the opposite of what it
                  looks like — see `groupRule`. */}
              {source.exclude && (
                <Text size="10px" c="dimmed" lh={1.3}>
                  {groupRule(true)}
                </Text>
              )}
            </>
          ) : (
            <Text size="sm" fw={500} lh={1.3} lineClamp={1} c={on ? undefined : 'dimmed'}>
              {name}
            </Text>
          )}
        </Stack>
      </Group>

      <Group gap={4} wrap="nowrap" className="shrink-0 self-center">
        {addControl}
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
          <Tooltip label={grouped ? 'Remove this group' : 'Remove from hub'}>
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
