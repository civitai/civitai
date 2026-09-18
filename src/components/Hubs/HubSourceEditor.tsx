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
import type { HubSourceSuggestion } from '~/components/Hubs/HubSourceSearch';
import { HubSourceSearch } from '~/components/Hubs/HubSourceSearch';
import { HubSourceUrlInput } from '~/components/Hubs/HubSourceUrlInput';
import type { HubSourceGroup } from '~/components/Hubs/hub.utils';
import {
  addTagToHubGroup,
  groupHubSources,
  removeHubGroup,
  removeTagFromHubGroup,
  setHubGroupEnabled,
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

type AddMode = 'include' | 'exclude';

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
  isAdded: (suggestion: HubSourceSuggestion) => boolean;
  onSelect: (suggestion: HubSourceSuggestion) => void;
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

  const held = (target: { type: UserHubSourceType; targetId: number }) =>
    value.find((source) => hubSourceKey(source) === hubSourceKey(target));

  // Told, not silently dropped: either list can be long enough that the clashing row
  // is off screen, so the same click would otherwise appear to do nothing whether the
  // target was already collected or currently kept out.
  const notifyClash = (clash: HubSourceValue, targetId: number) =>
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

  /** True when the list this source would join is full, and the caller must stop. */
  const refuseForCap = (asExclusion: boolean) => {
    const count = asExclusion ? excluded.length : included.length;
    const cap = asExclusion ? maxExclusions : maxSources;
    if (count < cap) return false;
    showErrorNotification({
      title: asExclusion ? 'Exclusion list is full' : 'Hub is full',
      error: new Error(
        asExclusion
          ? `A hub can exclude at most ${cap} sources.`
          : `A hub can hold at most ${cap} sources.`
      ),
    });
    return true;
  };

  const addSource = (type: UserHubSourceType, targetId: number, rawAlias: string) => {
    // Across BOTH lists, matching the row's unique key: a target the hub already
    // collects cannot also be excluded.
    const clash = held({ type, targetId });
    if (clash) return notifyClash(clash, targetId);
    if (refuseForCap(exclude)) return;
    onChange([
      ...value,
      {
        type,
        targetId,
        // Match what the server stores, so the optimistic row is not a different
        // string from the one that comes back.
        alias: rawAlias.trim().slice(0, hubLimits.aliasLength),
        enabled: true,
        exclude,
        index: value.length,
        groupKey: null,
      },
    ]);
  };

  const addToGroup = (group: HubSourceGroup, item: HubSourceSuggestion) => {
    const first = group.sources[0];
    const clash = held(item);
    // A tag already on the OTHER side of `exclude` is refused, not moved: that would
    // flip it from blocking content to surfacing it, which is a different decision
    // from grouping. One on THIS side is moved in, and spends no cap — no new row.
    if (clash && !!clash.exclude !== !!first.exclude) return notifyClash(clash, item.targetId);
    if (!clash && refuseForCap(!!first.exclude)) return;
    onChange(addTagToHubGroup(value, group, item));
  };

  const renderGroup = (group: HubSourceGroup) => {
    const [first, ...rest] = group.sources;
    const isTag = first.type === UserHubSourceType.Tag;
    const members = new Set(group.sources.map(hubSourceKey));

    return (
      <HubSourceCard
        key={group.key}
        source={first}
        extraTags={rest.map((source) => ({ targetId: source.targetId, alias: source.alias }))}
        onRemoveTag={
          readOnly || rest.length === 0
            ? undefined
            : (targetId) => onChange(removeTagFromHubGroup(value, targetId))
        }
        addControl={
          isTag && !readOnly ? (
            <AddTagToGroup
              exclude={first.exclude}
              disabled={disabled}
              // "Added" means "cannot join this group", which is narrower than
              // "already in this hub": a tag the hub holds on the same side is
              // selectable, and picking it MOVES it in.
              isAdded={(item) => {
                const clash = held(item);
                if (!clash) return false;
                return !!clash.exclude !== !!first.exclude || members.has(hubSourceKey(clash));
              }}
              onSelect={(item) => addToGroup(group, item)}
            />
          ) : undefined
        }
        disabled={disabled}
        onToggle={(enabled) => onChange(setHubGroupEnabled(value, group, enabled))}
        hideRemove={readOnly}
        onRemove={() => onChange(removeHubGroup(value, group))}
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
                    isAdded={(item) => !!held(item)}
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
