import { Button, Card, Collapse, SegmentedControl, Stack, Text } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { HubSourceCard } from '~/components/Hubs/HubSourceCard';
import { HubSourceSearch } from '~/components/Hubs/HubSourceSearch';
import { HubSourceUrlInput } from '~/components/Hubs/HubSourceUrlInput';
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

type AddMode = 'include' | 'exclude';

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

  const collected = value.filter((source) => !source.exclude);
  const excluded = value.filter((source) => source.exclude);

  const addSource = (type: UserHubSourceType, targetId: number, rawAlias: string) => {
    // Match what the server stores, so the optimistic row is not a different
    // string from the one that comes back.
    const alias = rawAlias.trim().slice(0, hubLimits.aliasLength);
    // Across BOTH lists, matching the row's unique key: a target the hub already
    // collects cannot also be excluded. Told, not silently dropped — the same click
    // did nothing whether the target was already collected or currently kept out, and
    // either list can be long enough that neither is on screen.
    const clash = value.find((s) => s.type === type && s.targetId === targetId);
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
      return;
    }
    const held = exclude ? excluded.length : collected.length;
    const cap = exclude ? maxExclusions : maxSources;
    if (held >= cap) {
      showErrorNotification({
        title: exclude ? 'Exclusion list is full' : 'Hub is full',
        error: new Error(
          exclude
            ? `A hub can exclude at most ${cap} sources.`
            : `A hub can hold at most ${cap} sources.`
        ),
      });
      return;
    }
    onChange([...value, { type, targetId, alias, enabled: true, exclude, index: value.length }]);
  };

  const renderCard = (source: HubSourceValue) => (
    <HubSourceCard
      key={`${source.type}-${source.targetId}`}
      source={source}
      disabled={disabled}
      onToggle={(enabled) =>
        onChange(
          value.map((s) =>
            s.type === source.type && s.targetId === source.targetId ? { ...s, enabled } : s
          )
        )
      }
      hideRemove={readOnly}
      onRemove={() =>
        onChange(value.filter((s) => !(s.type === source.type && s.targetId === source.targetId)))
      }
    />
  );

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
                    isAdded={(item) =>
                      value.some((s) => s.type === item.type && s.targetId === item.targetId)
                    }
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

      {collected.length === 0 ? (
        <Text size="sm" c="dimmed">
          {emptyMessage}
        </Text>
      ) : (
        <Stack gap={6}>{collected.map(renderCard)}</Stack>
      )}

      {excluded.length > 0 && (
        <Stack gap={6}>
          <Text size="xs" fw={700} tt="uppercase" c="dimmed" className="tracking-wide">
            Kept out
          </Text>
          {excluded.map(renderCard)}
        </Stack>
      )}
    </Stack>
  );
}
