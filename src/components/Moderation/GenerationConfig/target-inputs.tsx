import type { ComboboxProps } from '@mantine/core';
import { Badge, Group, MultiSelect, Stack, TagsInput, Text } from '@mantine/core';
import { useMemo } from 'react';
import { ecosystemByKey, ecosystems } from '~/shared/constants/basemodel.constants';
import { workflowConfigByKey } from '~/shared/data-graph/generation/config/workflows';

/** Parse a TagsInput value (strings) into positive integers; returns the bad entries separately. */
export function parseIds(values: string[] | undefined): { ids: number[]; invalid: string[] } {
  const ids: number[] = [];
  const invalid: string[] = [];
  for (const raw of values ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n > 0) ids.push(n);
    else invalid.push(raw);
  }
  return { ids: Array.from(new Set(ids)), invalid };
}

/** Strip empty / whitespace-only entries and dedupe — keeps free-form keys as-is. */
export function normalizeKeys(values: string[] | undefined): string[] {
  return Array.from(
    new Set((values ?? []).map((v) => v.trim()).filter((v): v is string => v.length > 0))
  );
}

type Targets = {
  ecosystems: string[];
  workflows: string[];
  modelVersionIds: (string | number)[];
};

/** Every target, grouped by kind and named, for a read-only card. */
export function TargetDetails({
  ecosystems,
  workflows,
  modelVersionIds,
  emptyText,
}: Targets & { emptyText: string }) {
  const groups = [
    {
      label: 'Ecosystems',
      values: ecosystems.map((key) => ecosystemByKey.get(key)?.displayName ?? key),
    },
    {
      label: 'Workflows',
      values: workflows.map((key) => workflowConfigByKey.get(key)?.label ?? key),
    },
    { label: 'Versions', values: modelVersionIds.map(String) },
  ].filter((group) => group.values.length);

  if (!groups.length)
    return (
      <Text size="xs" c="dimmed" fs="italic">
        {emptyText}
      </Text>
    );

  return (
    <Stack gap={4}>
      {groups.map((group) => (
        <Group key={group.label} gap={4} wrap="wrap">
          <Text size="xs" c="dimmed" w={72} className="shrink-0">
            {group.label}
          </Text>
          {group.values.map((value) => (
            <Badge key={value} size="sm" variant="default" tt="none" fw={500}>
              {value}
            </Badge>
          ))}
        </Group>
      ))}
    </Stack>
  );
}

const ECOSYSTEM_SUGGESTIONS = [...ecosystems]
  .sort((a, b) => a.sortOrder - b.sortOrder)
  .map((e) => e.key);

const renderEcosystemOption = ({ option }: { option: { value: string } }) => {
  const eco = ecosystemByKey.get(option.value);
  if (!eco) return option.value;
  return (
    <span>
      <Text span fw={500}>
        {eco.displayName}
      </Text>{' '}
      <Text span c="dimmed" size="xs">
        ({option.value})
      </Text>
    </span>
  );
};

/**
 * Workflow options by name (stored by key). A key already saved but no longer in
 * the config stays listed, so it remains visible and removable.
 */
function useWorkflowOptions(attachedKeys: string[]) {
  const fingerprint = attachedKeys.join(',');
  return useMemo(() => {
    const labelByKey = new Map<string, string>();
    for (const [key, config] of workflowConfigByKey) labelByKey.set(key, config.label ?? key);
    for (const key of attachedKeys) if (!labelByKey.has(key)) labelByKey.set(key, key);
    return [...labelByKey.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attachedKeys is rebuilt each render; compare by value
  }, [fingerprint]);
}

export type TargetValues = { ecosystems: string[]; workflows: string[]; modelVersionIds: string[] };

export function TargetInputs({
  value,
  onChange,
  versionIdsDescription,
  comboboxProps,
}: {
  value: TargetValues;
  onChange: (patch: Partial<TargetValues>) => void;
  versionIdsDescription?: string;
  comboboxProps?: ComboboxProps;
}) {
  const workflowOptions = useWorkflowOptions(value.workflows);

  return (
    <>
      <TagsInput
        label="Ecosystems"
        placeholder="Pick or type an ecosystem key…"
        data={ECOSYSTEM_SUGGESTIONS}
        renderOption={renderEcosystemOption}
        value={value.ecosystems}
        onChange={(v) => onChange({ ecosystems: v })}
        splitChars={[',', ' ']}
        acceptValueOnBlur
        clearable
        comboboxProps={comboboxProps}
      />
      <MultiSelect
        label="Workflows"
        placeholder="Pick a workflow…"
        data={workflowOptions}
        value={value.workflows}
        onChange={(v) => onChange({ workflows: v })}
        searchable
        clearable
        comboboxProps={comboboxProps}
      />
      <TagsInput
        label="Model version IDs"
        description={versionIdsDescription}
        placeholder="e.g. 12345"
        value={value.modelVersionIds}
        onChange={(v) => onChange({ modelVersionIds: v })}
        splitChars={[',', ' ']}
        clearable
      />
    </>
  );
}
