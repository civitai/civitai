import { ActionIcon, Badge, Group, Paper, Stack, Switch, Text, Tooltip } from '@mantine/core';
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
  /** Drop one tag out of the group. Absent when the group is not the viewer's to edit. */
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

/**
 * 🔴 The two halves of a group mean OPPOSITE things, and the wording is the only place
 * that says so. Grouping tags you want NARROWS the feed; grouping tags you want gone
 * REMOVES LESS, because `NOT (x AND y)` keeps an image carrying only x. Justin approved
 * this asymmetry on 2026-09-17 — if the copy changes, keep it.
 *
 * Exported only so `hub-groups.test.ts` can pin both strings. That test is not
 * decoration: nothing else in the toolchain can tell that the two labels have been
 * made to agree, and two agreeing labels describe one of the two behaviours wrongly.
 */
export const groupRule = (exclude?: boolean) =>
  exclude ? 'Only block when all of these match' : 'Require all of these';

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
                    rightSection={
                      onRemoveTag && (
                        <ActionIcon
                          size={14}
                          variant="transparent"
                          color={on ? color : 'gray'}
                          disabled={disabled}
                          aria-label={`Remove ${tag.alias ?? tag.targetId} from group`}
                          onClick={() => onRemoveTag(tag.targetId)}
                        >
                          <IconX size={10} />
                        </ActionIcon>
                      )
                    }
                  >
                    {tag.alias ?? `#${tag.targetId}`}
                  </Badge>
                ))}
              </Group>
              <Text size="10px" c="dimmed" lh={1.3}>
                {groupRule(source.exclude)}
              </Text>
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
