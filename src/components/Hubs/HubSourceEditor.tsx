import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Collapse,
  Group,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { HubSourceSearch } from '~/components/Hubs/HubSourceSearch';
import { HubSourceUrlInput } from '~/components/Hubs/HubSourceUrlInput';
import { hubLimits } from '~/server/schema/user-hub.schema';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';

export type HubSourceValue = {
  type: UserHubSourceType;
  targetId: number;
  alias?: string | null;
  enabled: boolean;
  index: number;
};

const sourceLabels: Record<UserHubSourceType, string> = {
  [UserHubSourceType.User]: 'Creator',
  [UserHubSourceType.Model]: 'Model',
  [UserHubSourceType.ModelVersion]: 'Version',
  [UserHubSourceType.Collection]: 'Collection',
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
        <Stack gap={4}>
          {value.map((source) => (
            <Group key={`${source.type}-${source.targetId}`} justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap" className="min-w-0">
                <Badge size="sm" variant="light">
                  {sourceLabels[source.type]}
                </Badge>
                <Text size="sm" lineClamp={1}>
                  {source.alias ?? `#${source.targetId}`}
                </Text>
              </Group>
              <Group gap="xs" wrap="nowrap">
                <Tooltip label={source.enabled ? 'Showing in this hub' : 'Hidden from this hub'}>
                  <Switch
                    size="xs"
                    checked={source.enabled}
                    disabled={disabled}
                    aria-label={`Toggle ${source.alias ?? source.targetId}`}
                    onChange={(event) =>
                      onChange(
                        value.map((s) =>
                          s.type === source.type && s.targetId === source.targetId
                            ? { ...s, enabled: event.currentTarget.checked }
                            : s
                        )
                      )
                    }
                  />
                </Tooltip>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  disabled={disabled}
                  aria-label={`Remove ${source.alias ?? source.targetId}`}
                  onClick={() =>
                    onChange(
                      value.filter(
                        (s) => !(s.type === source.type && s.targetId === source.targetId)
                      )
                    )
                  }
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
