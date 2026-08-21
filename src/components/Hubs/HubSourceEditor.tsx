import { Button, Card, Collapse, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { HubSourceCardA } from '~/components/Hubs/HubSourceCardA';
import { HubSourceCardB } from '~/components/Hubs/HubSourceCardB';
import { HubSourceCardC } from '~/components/Hubs/HubSourceCardC';
import { HubSourceSearch } from '~/components/Hubs/HubSourceSearch';
import { HubSourceUrlInput } from '~/components/Hubs/HubSourceUrlInput';
import { hubLimits } from '~/server/schema/user-hub.schema';
import type { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';

// Three candidate designs for the source row, switchable in place so they can be
// compared against real data. Collapse to the winner and delete the other two.
const cardVariants = [
  { value: 'A' as const, Card: HubSourceCardA },
  { value: 'B' as const, Card: HubSourceCardB },
  { value: 'C' as const, Card: HubSourceCardC },
];

type CardVariant = (typeof cardVariants)[number]['value'];

const VARIANT_KEY = 'hub-source-card-variant';

export type HubSourceValue = {
  type: UserHubSourceType;
  targetId: number;
  alias?: string | null;
  enabled: boolean;
  index: number;
};

/**
 * The source list plus the affordance that adds to it. Controlled, so the same
 * editor serves the create modal — where there is no hub row to write to yet —
 * and the rail, where every change is a save.
 */
export function HubSourceEditor({
  value,
  onChange,
  maxSources = hubLimits.sourcesPerHub,
  disabled,
  emptyMessage = 'Nothing here yet. Add a creator or a model to start filling it.',
}: {
  value: HubSourceValue[];
  onChange: (next: HubSourceValue[]) => void;
  maxSources?: number;
  disabled?: boolean;
  emptyMessage?: string;
}) {
  const [adding, setAdding] = useState(false);
  // Read after mount rather than during render: the server has no localStorage, so
  // seeding state from it directly is a hydration mismatch.
  const [variant, setVariant] = useState<CardVariant>('A');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(VARIANT_KEY);
      if (stored === 'A' || stored === 'B' || stored === 'C') setVariant(stored);
    } catch {
      // Private windows and blocked site data throw on access.
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(VARIANT_KEY, variant);
    } catch {
      // As above — a preference that cannot be saved is not worth an error.
    }
  }, [variant]);

  const SourceCard = (cardVariants.find((v) => v.value === variant) ?? cardVariants[0]).Card;

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

      {value.length === 0 ? (
        <Text size="sm" c="dimmed">
          {emptyMessage}
        </Text>
      ) : (
        <Stack gap={6}>
          <Group gap={6} wrap="nowrap" justify="space-between">
            <Text size="10px" tt="uppercase" fw={700} c="dimmed">
              Card style
            </Text>
            <SegmentedControl
              size="xs"
              value={variant}
              data={cardVariants.map(({ value: v }) => ({ value: v, label: v }))}
              onChange={(next) => setVariant(next as CardVariant)}
            />
          </Group>

          <Stack gap={4}>
            {value.map((source) => (
              <SourceCard
                key={`${source.type}-${source.targetId}`}
                source={source}
                disabled={disabled}
                onToggle={(enabled) =>
                  onChange(
                    value.map((s) =>
                      s.type === source.type && s.targetId === source.targetId
                        ? { ...s, enabled }
                        : s
                    )
                  )
                }
                onRemove={() =>
                  onChange(
                    value.filter((s) => !(s.type === source.type && s.targetId === source.targetId))
                  )
                }
              />
            ))}
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}
