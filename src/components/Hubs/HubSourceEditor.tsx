import { Badge, Text, UnstyledButton } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { HubSourceInput } from '~/components/Hubs/HubSourceInput';
import { hubSourceKindLabel, kindColor } from '~/components/Hubs/hub.utils';
import { hubLimits } from '~/server/schema/user-hub.schema';
import type { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';

export type HubSourceValue = {
  type: UserHubSourceType;
  targetId: number;
  alias?: string | null;
  enabled: boolean;
  /** A negative source: kept OUT of the hub rather than collected into it. */
  exclude: boolean;
  index: number;
};

function SourceChip({
  source,
  exclude,
  disabled,
  onRemove,
}: {
  source: HubSourceValue;
  exclude?: boolean;
  disabled?: boolean;
  onRemove: VoidFunction;
}) {
  return (
    <div
      className={clsx(
        'flex max-w-full items-center gap-1.5 rounded-full border py-1 pl-3 pr-1.5',
        exclude
          ? 'border-red-4 bg-red-0 dark:border-red-9 dark:bg-red-9/20'
          : 'border-gray-3 dark:border-dark-4'
      )}
    >
      <Text size="sm" lineClamp={1}>
        {source.alias ?? `#${source.targetId}`}
      </Text>
      <Badge
        size="xs"
        variant="light"
        color={exclude ? 'red' : kindColor[source.type] ?? 'gray'}
        className="shrink-0"
      >
        {hubSourceKindLabel(source.type)}
      </Badge>
      <UnstyledButton
        aria-label={`Remove ${source.alias ?? source.targetId}`}
        disabled={disabled}
        onClick={onRemove}
        className="shrink-0 text-gray-6 hover:text-gray-9 dark:text-dark-2 dark:hover:text-white"
      >
        <IconX size={14} />
      </UnstyledButton>
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
    value.find((source) => source.type === type && source.targetId === targetId);

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

    const count = exclude ? excluded.length : included.length;
    const cap = exclude ? hubLimits.exclusionsPerHub : hubLimits.sourcesPerHub;
    if (count >= cap) {
      showErrorNotification({
        title: exclude ? 'Never-show list is full' : 'Hub is full',
        error: new Error(
          exclude
            ? `A hub can keep out at most ${cap} things.`
            : `A hub can hold at most ${cap} things.`
        ),
      });
      return;
    }

    onChange([...value, { type, targetId, alias, enabled: true, exclude, index: value.length }]);
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
    onChange(value.filter((s) => !(s.type === target.type && s.targetId === target.targetId)));

  const remove = (source: HubSourceValue) =>
    onChange(value.filter((s) => !(s.type === source.type && s.targetId === source.targetId)));

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
        <div className="flex flex-wrap gap-2">
          {included.map((source) => (
            <SourceChip
              key={`${source.type}-${source.targetId}`}
              source={source}
              disabled={disabled}
              onRemove={() => remove(source)}
            />
          ))}
        </div>
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
          {excluded.map((source) => (
            <SourceChip
              key={`${source.type}-${source.targetId}`}
              source={source}
              exclude
              disabled={disabled}
              onRemove={() => remove(source)}
            />
          ))}

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
