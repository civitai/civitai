import { Badge, Popover, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { HubSourceInput } from '~/components/Hubs/HubSourceInput';
import type { HubSourceGroup } from '~/components/Hubs/hub.utils';
import {
  addTagToHubGroup,
  excludeGroupRule,
  findHubSource,
  groupAddHint,
  groupHubSources,
  groupMemberKeys,
  hubSourceKindLabel,
  kindColor,
  removeHubGroup,
  removeHubTag,
} from '~/components/Hubs/hub.utils';
import { hubLimits, hubSourceKey } from '~/server/schema/user-hub.schema';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';

export type HubSourceValue = {
  type: UserHubSourceType;
  targetId: number;
  alias?: string | null;
  enabled: boolean;
  /** A negative source: kept OUT of the hub rather than collected into it. */
  exclude: boolean;
  index: number;
  /**
   * A tag AND-set. Tag sources sharing a key, on the same side of `exclude`, must ALL
   * match; null is a group of one, which is every source that predates the column.
   */
  groupKey?: number | null;
};

/**
 * The add-another-tag affordance. The Tooltip sits OUTSIDE the Popover rather than
 * inside `Popover.Target`: both clone their child to attach a ref, and stacking them on
 * one element is the shape that silently stops the trigger opening (CLAUDE.md records
 * it for `Menu.Target`).
 */
function AddToGroup({
  exclude,
  disabled,
  isAdded,
  onSelect,
  onRemove,
}: {
  exclude?: boolean;
  disabled?: boolean;
  isAdded: (source: { type: UserHubSourceType; targetId: number }) => boolean;
  onSelect: (item: { type: UserHubSourceType; targetId: number; alias: string }) => void;
  onRemove: (target: { type: UserHubSourceType; targetId: number }) => void;
}) {
  const [opened, setOpened] = useState(false);

  return (
    <Tooltip label={groupAddHint(exclude)}>
      <div className="flex">
        <Popover
          opened={opened}
          onChange={setOpened}
          position="bottom-start"
          width={280}
          shadow="md"
          // 🔴 Explicit. ThemeProvider defaults every Popover to withinPortal={false},
          // and a chip row is a flex container that clips, so the dropdown is drawn
          // truncated without it.
          withinPortal
        >
          <Popover.Target>
            <UnstyledButton
              disabled={disabled}
              aria-label={groupAddHint(exclude)}
              onClick={() => setOpened((open) => !open)}
              className="shrink-0 text-gray-6 hover:text-gray-9 dark:text-dark-2 dark:hover:text-white"
            >
              <IconPlus size={14} />
            </UnstyledButton>
          </Popover.Target>
          <Popover.Dropdown p="xs">
            <HubSourceInput
              autoFocus
              only="tags"
              disabled={disabled}
              remaining={hubLimits.sourcesPerHub}
              isAdded={isAdded}
              onAdd={(item) => {
                onSelect(item);
                setOpened(false);
              }}
              onRemove={onRemove}
            />
          </Popover.Dropdown>
        </Popover>
      </div>
    </Tooltip>
  );
}

/**
 * One chip per GROUP, not per source: tag sources sharing a `groupKey` are ANDed, so
 * they are one thing the feed does and have to read as one thing here. Every other kind
 * is always a group of one.
 */
function SourceChip({
  group,
  exclude,
  disabled,
  onRemoveGroup,
  onRemoveTag,
  addControl,
}: {
  group: HubSourceGroup;
  exclude?: boolean;
  disabled?: boolean;
  onRemoveGroup: VoidFunction;
  onRemoveTag: (targetId: number) => void;
  addControl?: React.ReactNode;
}) {
  const [first] = group.sources;
  const grouped = group.sources.length > 1;
  const name = (source: HubSourceValue) => source.alias ?? `#${source.targetId}`;

  return (
    <div
      className={clsx(
        'flex max-w-full items-center gap-1.5 rounded-full border py-1 pl-3 pr-1.5',
        exclude
          ? 'border-red-4 bg-red-0 dark:border-red-9 dark:bg-red-9/20'
          : 'border-gray-3 dark:border-dark-4'
      )}
    >
      {group.sources.map((source, index) => (
        <div key={source.targetId} className="flex min-w-0 items-center gap-1">
          {/* The AND, said with a glyph rather than a word: the chip is already
              narrow, and "and" beside a tag name reads as part of the tag. */}
          {index > 0 && (
            <Text size="xs" c="dimmed" className="shrink-0">
              +
            </Text>
          )}
          <Text size="sm" lineClamp={1}>
            {name(source)}
          </Text>
          {/* Only once the group holds more than one: at one member the chip's own ✕
              already means this, and two ✕ on one chip is a choice nobody has. */}
          {grouped && (
            <UnstyledButton
              aria-label={`Remove ${name(source)} from this hub`}
              disabled={disabled}
              onClick={() => onRemoveTag(source.targetId)}
              className="shrink-0 text-gray-6 hover:text-gray-9 dark:text-dark-2 dark:hover:text-white"
            >
              <IconX size={12} />
            </UnstyledButton>
          )}
        </div>
      ))}

      <Badge
        size="xs"
        variant="light"
        color={exclude ? 'red' : kindColor[first.type] ?? 'gray'}
        className="shrink-0"
      >
        {hubSourceKindLabel(first.type)}
      </Badge>

      {addControl}

      {!grouped && (
        <UnstyledButton
          aria-label={`Remove ${name(first)}`}
          disabled={disabled}
          onClick={onRemoveGroup}
          className="shrink-0 text-gray-6 hover:text-gray-9 dark:text-dark-2 dark:hover:text-white"
        >
          <IconX size={14} />
        </UnstyledButton>
      )}
    </div>
  );
}

/**
 * What goes in a hub, and what never does.
 *
 * An always-present picker per list rather than an "add source" mode with an
 * include/exclude switch: both were things to learn before anything could be added,
 * and the exclusions are better said as their own short list than as a state of the
 * same one. The picker's tabs are not the old type tabs — those gated adding until you
 * declared a kind; these only choose which shelf you browse.
 *
 * Sources carry an `enabled` flag that nothing here sets any more. A source is in the
 * hub or removed from it; the flag stays true for everything this writes.
 */
export function HubSourceEditor({
  value,
  onChange,
  disabled,
  emptyMessage = 'Nothing here yet — search above to start filling it.',
}: {
  value: HubSourceValue[];
  onChange: (next: HubSourceValue[]) => void;
  disabled?: boolean;
  emptyMessage?: string;
}) {
  const [addingExclusion, setAddingExclusion] = useState(false);

  const included = value.filter((source) => !source.exclude);
  const excluded = value.filter((source) => source.exclude);

  const held = (type: UserHubSourceType, targetId: number) =>
    findHubSource(value, { type, targetId });

  const atCap = (exclude: boolean) => {
    const count = exclude ? excluded.length : included.length;
    const cap = exclude ? hubLimits.exclusionsPerHub : hubLimits.sourcesPerHub;
    if (count < cap) return false;
    showErrorNotification({
      title: exclude ? 'Never-show list is full' : 'Hub is full',
      error: new Error(
        exclude
          ? `A hub can keep out at most ${cap} things.`
          : `A hub can hold at most ${cap} things.`
      ),
    });
    return true;
  };

  const addSource = (
    {
      type,
      targetId,
      alias: rawAlias,
    }: { type: UserHubSourceType; targetId: number; alias: string },
    exclude: boolean
  ) => {
    // Match what the server stores, so the optimistic chip is not a different string
    // from the one that comes back.
    const alias = rawAlias.trim().slice(0, hubLimits.aliasLength);

    // Across BOTH lists, matching the row's unique key: a target the hub already
    // collects cannot also be excluded. Told, not silently dropped — either list can
    // be long enough that the clash is off screen.
    const clash = held(type, targetId);
    if (clash) {
      showErrorNotification({
        title: 'Already in this hub',
        error: new Error(
          clash.exclude
            ? `"${clash.alias ?? targetId}" is on the never-show list. Remove it from there first.`
            : `"${clash.alias ?? targetId}" is already in this hub.`
        ),
      });
      return;
    }

    if (atCap(exclude)) return;

    onChange([...value, { type, targetId, alias, enabled: true, exclude, index: value.length }]);
  };

  /**
   * Add a tag to an existing group. The transform MOVES a tag the hub already holds
   * rather than adding a row, so the cap is only spent on a genuinely new one — and
   * the caller owns both checks because only it can say why a click was refused.
   */
  const addToGroup = (
    group: HubSourceGroup,
    item: { type: UserHubSourceType; targetId: number; alias: string }
  ) => {
    if (item.type !== UserHubSourceType.Tag) {
      showErrorNotification({
        title: 'Tags only',
        error: new Error('Only tags can be required together. Add that to the hub itself instead.'),
      });
      return;
    }

    const target = { type: UserHubSourceType.Tag, targetId: item.targetId };
    const existing = findHubSource(value, target);
    const exclude = !!group.sources[0].exclude;

    // The transform returns `value` untouched for this case; the message is the half
    // it cannot show. Moving it anyway would give the row one side's group key and the
    // other side's `exclude`, quietly weakening an exclusion the owner set.
    if (existing && !!existing.exclude !== exclude) {
      showErrorNotification({
        title: 'Already in this hub',
        error: new Error(
          existing.exclude
            ? `"${
                existing.alias ?? item.targetId
              }" is on the never-show list. Remove it from there first.`
            : `"${existing.alias ?? item.targetId}" is already in this hub.`
        ),
      });
      return;
    }

    if (!existing && atCap(exclude)) return;

    onChange(addTagToHubGroup(value, group, item));
  };

  // A group's "Add 50" — everything that still fits, in the order it was gathered.
  // Capped here rather than refused, because overrunning is the expected case for the
  // people these actions are for: 568 follows, 50 slots.
  const addMany = (incoming: HubSourceValue[]) => {
    const room = hubLimits.sourcesPerHub - included.length;
    if (room <= 0) return;

    const fresh = incoming.filter((source) => !held(source.type, source.targetId));
    const taken = fresh.slice(0, room).map((source) => ({ ...source, exclude: false }));
    if (!taken.length) return;

    onChange([...value, ...taken].map((source, index) => ({ ...source, index })));
  };

  // A row in the list toggles, so taking something back out does not mean hunting
  // down its chip.
  const removeByTarget = (target: { type: UserHubSourceType; targetId: number }) =>
    onChange(value.filter((source) => hubSourceKey(source) !== hubSourceKey(target)));

  const chipsFor = (sources: HubSourceValue[], exclude: boolean) =>
    groupHubSources(sources).map((group) => {
      const [first] = group.sources;
      const members = groupMemberKeys(group);
      return (
        <SourceChip
          key={group.key}
          group={group}
          exclude={exclude}
          disabled={disabled}
          onRemoveGroup={() => onChange(removeHubGroup(value, group))}
          onRemoveTag={(targetId) => onChange(removeHubTag(value, targetId))}
          addControl={
            first.type === UserHubSourceType.Tag && (
              <AddToGroup
                exclude={exclude}
                disabled={disabled}
                isAdded={(source) => members.has(hubSourceKey(source))}
                onSelect={(item) => addToGroup(group, item)}
                onRemove={(target) => onChange(removeHubTag(value, target.targetId))}
              />
            )
          }
        />
      );
    });

  // EXCLUDE ONLY. The include-side line was cut after seeing it rendered: a row of
  // chips joined by `+` reads as "all of these" unaided, while the exclude side means
  // the opposite of what people assume — `NOT (x AND y)` keeps an image carrying only
  // x, so grouping there removes LESS.
  const hasExcludeGroup = groupHubSources(excluded).some((group) => group.sources.length > 1);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Text size="sm" fw={600}>
          What goes in it
        </Text>
        <HubSourceInput
          disabled={disabled}
          remaining={hubLimits.sourcesPerHub - included.length}
          isAdded={(source) => !!held(source.type, source.targetId)}
          onAdd={(source) => addSource(source, false)}
          onRemove={removeByTarget}
          onAddMany={addMany}
        />
      </div>

      {included.length ? (
        <div className="flex flex-wrap gap-2">{chipsFor(included, false)}</div>
      ) : (
        <Text size="sm" c="dimmed">
          {emptyMessage}
        </Text>
      )}

      {!!included.length && (
        <Text size="xs" c="dimmed">
          {included.length} of {hubLimits.sourcesPerHub} — creators, models and tags share one
          budget
        </Text>
      )}

      <div className="flex flex-col gap-2">
        <Text size="xs" fw={700} tt="uppercase" c="dimmed">
          Never show
        </Text>

        <div className="flex flex-wrap gap-2">
          {chipsFor(excluded, true)}

          {!addingExclusion && (
            <UnstyledButton
              disabled={disabled}
              onClick={() => setAddingExclusion(true)}
              className="flex items-center gap-1 rounded-full border border-dashed border-gray-4 px-3 py-1 text-sm text-gray-6 hover:text-gray-9 dark:border-dark-4 dark:text-dark-2 dark:hover:text-white"
            >
              <IconPlus size={14} />
              Keep something out
            </UnstyledButton>
          )}
        </div>

        {hasExcludeGroup && (
          <Text size="xs" c="dimmed">
            {excludeGroupRule}
          </Text>
        )}

        {addingExclusion && (
          <HubSourceInput
            autoFocus
            exclude
            disabled={disabled}
            remaining={hubLimits.exclusionsPerHub - excluded.length}
            isAdded={(source) => !!held(source.type, source.targetId)}
            onAdd={(source) => addSource(source, true)}
            onRemove={removeByTarget}
          />
        )}
      </div>
    </div>
  );
}
