import {
  ActionIcon,
  Button,
  Card,
  Collapse,
  Popover,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { HubSourceCard } from '~/components/Hubs/HubSourceCard';
import { HubSourceSearch } from '~/components/Hubs/HubSourceSearch';
import { HubSourceUrlInput } from '~/components/Hubs/HubSourceUrlInput';
import type { HubSourceGroup } from '~/components/Hubs/hub.utils';
import { groupHubSources, nextHubGroupKey } from '~/components/Hubs/hub.utils';
import { hubLimits } from '~/server/schema/user-hub.schema';
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

type AddMode = 'include' | 'exclude';

type Suggestion = { type: UserHubSourceType; targetId: number; alias: string };

/**
 * The add-another-tag affordance on a tag card. The Tooltip sits OUTSIDE the Popover
 * rather than inside `Popover.Target`: both components clone their child to attach a
 * ref, and stacking them on one element is the shape that silently stops the trigger
 * opening (CLAUDE.md records it for `Menu.Target`).
 */
function AddTagToGroup({
  exclude,
  disabled,
  isAdded,
  onSelect,
}: {
  exclude?: boolean;
  disabled?: boolean;
  isAdded: (suggestion: Suggestion) => boolean;
  onSelect: (suggestion: Suggestion) => void;
}) {
  const [opened, setOpened] = useState(false);

  return (
    <Tooltip label={exclude ? 'Only block when another tag matches too' : 'Require another tag'}>
      <div className="flex">
        <Popover
          opened={opened}
          onChange={setOpened}
          position="bottom-end"
          width={260}
          shadow="md"
          // 🔴 Explicit. ThemeProvider defaults every Popover to withinPortal={false},
          // and the card this renders inside is an overflow-hidden Paper, so the
          // dropdown is drawn clipped without it.
          withinPortal
        >
          <Popover.Target>
            <ActionIcon
              size="sm"
              variant="subtle"
              disabled={disabled}
              aria-label="Add another tag to this group"
              onClick={() => setOpened((open) => !open)}
            >
              <IconPlus size={14} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown p="xs">
            <HubSourceSearch
              onlyType={UserHubSourceType.Tag}
              disabled={disabled}
              isAdded={isAdded}
              onSelect={(item) => {
                onSelect(item);
                setOpened(false);
              }}
            />
          </Popover.Dropdown>
        </Popover>
      </div>
    </Tooltip>
  );
}

export function HubSourceEditor({
  value,
  onChange,
  maxSources = hubLimits.sourcesPerHub,
  maxExclusions = hubLimits.exclusionsPerHub,
  disabled,
  hideAdd,
  readOnly,
  emptyMessage = 'Nothing here yet. Add a creator or a model to start filling it.',
}: {
  value: HubSourceValue[];
  onChange: (next: HubSourceValue[]) => void;
  maxSources?: number;
  maxExclusions?: number;
  disabled?: boolean;
  /** Drop the add affordance, for surfaces too small to hold it open. */
  hideAdd?: boolean;
  /**
   * A hub you do not own: no add, no remove. Toggles stay live — the caller decides
   * where they land, and on someone else's hub that is session state, not a write.
   */
  readOnly?: boolean;
  emptyMessage?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>('include');
  const exclude = addMode === 'exclude';

  const included = value.filter((source) => !source.exclude);
  const excluded = value.filter((source) => source.exclude);
  const includedGroups = groupHubSources(included);
  const excludedGroups = groupHubSources(excluded);

  const sameTarget = (a: { type: UserHubSourceType; targetId: number }) => (b: HubSourceValue) =>
    b.type === a.type && b.targetId === a.targetId;

  /**
   * The two guards every add passes, whichever affordance ran it. Returns true when the
   * add was refused and the caller must stop — told rather than silently dropped, since
   * either list can be long enough that the clashing row is off screen.
   */
  const refuseAdd = (type: UserHubSourceType, targetId: number, asExclusion: boolean) => {
    // Across BOTH lists, matching the row's unique key: a target the hub already
    // collects cannot also be excluded.
    const clash = value.find(sameTarget({ type, targetId }));
    if (clash) {
      showErrorNotification({
        title: 'Already in this hub',
        error: new Error(
          clash.exclude
            ? `"${
                clash.alias ?? targetId
              }" is currently kept out of this hub. Remove it from the kept-out list first.`
            : `"${clash.alias ?? targetId}" is already one of this hub's sources.`
        ),
      });
      return true;
    }
    const held = asExclusion ? excluded.length : included.length;
    const cap = asExclusion ? maxExclusions : maxSources;
    if (held >= cap) {
      showErrorNotification({
        title: asExclusion ? 'Exclusion list is full' : 'Hub is full',
        error: new Error(
          asExclusion
            ? `A hub can exclude at most ${cap} sources.`
            : `A hub can hold at most ${cap} sources.`
        ),
      });
      return true;
    }
    return false;
  };

  const addSource = (type: UserHubSourceType, targetId: number, rawAlias: string) => {
    // Match what the server stores, so the optimistic row is not a different
    // string from the one that comes back.
    const alias = rawAlias.trim().slice(0, hubLimits.aliasLength);
    if (refuseAdd(type, targetId, exclude)) return;
    onChange([
      ...value,
      { type, targetId, alias, enabled: true, exclude, index: value.length, groupKey: null },
    ]);
  };

  // A tag joining a group is another row against the same cap as any other source —
  // grouping changes what the rows MEAN, not how many a hub may hold.
  const addToGroup = (group: HubSourceGroup, item: Suggestion) => {
    const first = group.sources[0];
    const alias = item.alias.trim().slice(0, hubLimits.aliasLength);
    if (refuseAdd(item.type, item.targetId, !!first.exclude)) return;
    // Reused when the card is already a group, minted when this is the second tag —
    // so the click that creates a group is the one that assigns its key.
    const groupKey = first.groupKey ?? nextHubGroupKey(value);
    const members = group.sources.map(sameTarget);
    onChange([
      ...value.map((source) =>
        members.some((matches) => matches(source)) ? { ...source, groupKey } : source
      ),
      {
        type: UserHubSourceType.Tag,
        targetId: item.targetId,
        alias,
        // The group toggles as one, so a tag joining a switched-off group must arrive
        // switched off — otherwise the card reads as on while half of it is not.
        enabled: first.enabled,
        exclude: !!first.exclude,
        index: value.length,
        groupKey,
      },
    ]);
  };

  const renderGroup = (group: HubSourceGroup) => {
    const [first, ...rest] = group.sources;
    const isTag = first.type === UserHubSourceType.Tag;
    const inGroup = (source: HubSourceValue) =>
      group.sources.some((member) => sameTarget(member)(source));

    return (
      <HubSourceCard
        key={group.key}
        source={first}
        extraTags={rest.map((source) => ({ targetId: source.targetId, alias: source.alias }))}
        onRemoveTag={
          readOnly || rest.length === 0
            ? undefined
            : (targetId) =>
                onChange(value.filter((s) => !sameTarget({ type: first.type, targetId })(s)))
        }
        addControl={
          isTag && !readOnly ? (
            <AddTagToGroup
              exclude={first.exclude}
              disabled={disabled}
              isAdded={(item) => value.some(sameTarget(item))}
              onSelect={(item) => addToGroup(group, item)}
            />
          ) : undefined
        }
        disabled={disabled}
        // The whole group at once: a half-enabled AND-set would filter on fewer tags
        // than the card shows, with nothing on screen saying which.
        onToggle={(enabled) => onChange(value.map((s) => (inGroup(s) ? { ...s, enabled } : s)))}
        hideRemove={readOnly}
        onRemove={() => onChange(value.filter((s) => !inGroup(s)))}
      />
    );
  };

  return (
    <Stack gap="sm">
      {!hideAdd && !readOnly && (
        <>
          <Button
            size="compact-sm"
            variant={adding ? 'light' : 'filled'}
            leftSection={adding ? <IconX size={14} /> : <IconPlus size={14} />}
            disabled={disabled}
            onClick={() => setAdding((open) => !open)}
          >
            {adding ? 'Done adding' : 'Add source'}
          </Button>

          <Collapse in={adding}>
            {adding && (
              <Card withBorder p="xs">
                <Stack gap="xs">
                  <SegmentedControl
                    size="xs"
                    fullWidth
                    value={addMode}
                    onChange={(next) => setAddMode(next as AddMode)}
                    data={[
                      { value: 'include', label: 'Include' },
                      { value: 'exclude', label: 'Exclude' },
                    ]}
                  />
                  <Text size="xs" c="dimmed">
                    {exclude
                      ? 'Content from what you pick is kept out of this hub.'
                      : 'Content from what you pick fills this hub.'}
                  </Text>
                  <HubSourceSearch
                    disabled={disabled}
                    isAdded={(item) => value.some(sameTarget(item))}
                    onSelect={(item) => addSource(item.type, item.targetId, item.alias)}
                  />
                  <HubSourceUrlInput
                    disabled={disabled}
                    onResolved={(source) => addSource(source.type, source.targetId, source.alias)}
                  />
                </Stack>
              </Card>
            )}
          </Collapse>
        </>
      )}

      {includedGroups.length === 0 ? (
        <Text size="sm" c="dimmed">
          {emptyMessage}
        </Text>
      ) : (
        <Stack gap={6}>{includedGroups.map(renderGroup)}</Stack>
      )}

      {excludedGroups.length > 0 && (
        <Stack gap={6}>
          <Text size="xs" fw={700} tt="uppercase" c="dimmed" className="tracking-wide">
            Kept out
          </Text>
          {excludedGroups.map(renderGroup)}
        </Stack>
      )}
    </Stack>
  );
}
