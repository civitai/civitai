import { Button, Card, Collapse, Stack, Text } from '@mantine/core';
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
  index: number;
};

export function HubSourceEditor({
  value,
  onChange,
  maxSources = hubLimits.sourcesPerHub,
  disabled,
  hideAdd,
  readOnly,
  emptyMessage = 'Nothing here yet. Add a creator or a model to start filling it.',
}: {
  value: HubSourceValue[];
  onChange: (next: HubSourceValue[]) => void;
  maxSources?: number;
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
  const addSource = (type: UserHubSourceType, targetId: number, rawAlias: string) => {
    // Match what the server stores, so the optimistic row is not a different
    // string from the one that comes back.
    const alias = rawAlias.trim().slice(0, hubLimits.aliasLength);
    if (value.some((s) => s.type === type && s.targetId === targetId)) return;
    if (value.length >= maxSources) {
      showErrorNotification({
        title: 'Hub is full',
        error: new Error(`A hub can hold at most ${maxSources} sources.`),
      });
      return;
    }
    onChange([...value, { type, targetId, alias, enabled: true, index: value.length }]);
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

      {value.length === 0 ? (
        <Text size="sm" c="dimmed">
          {emptyMessage}
        </Text>
      ) : (
        <Stack gap={6}>
          {value.map((source) => (
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
                onChange(
                  value.filter((s) => !(s.type === source.type && s.targetId === source.targetId))
                )
              }
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
