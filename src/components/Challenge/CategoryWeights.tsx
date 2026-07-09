import { ActionIcon, Badge, Button, Group, Paper, Progress, Stack, Text, Tooltip } from '@mantine/core';
import { IconLock, IconPlus, IconX } from '@tabler/icons-react';
import { useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { InputNumber, InputSelect } from '~/libs/form';
import {
  ADDABLE_PRESET_KEYS,
  type CategoryWeightRow,
  CHALLENGE_CATEGORY_GROUPS,
  CHALLENGE_PRESET_CATEGORIES,
  makeRow,
  MAX_CATEGORIES,
} from '~/shared/constants/challenge.constants';

// Build the grouped Select options for one row: every category the row may switch to — its own key
// plus any preset not already used by another row — grouped by vibe. Empty groups are dropped.
// Returns a flat, group-tagged list (InputSelect groups by the `group` field itself); iterating
// CHALLENGE_CATEGORY_GROUPS in order keeps the group order stable.
function keyOptionsFor(index: number, rows: CategoryWeightRow[]) {
  const currentKey = rows[index]?.key;
  const usedByOthers = new Set(rows.filter((_, i) => i !== index).map((r) => r.key));
  return CHALLENGE_CATEGORY_GROUPS.flatMap((group) =>
    ADDABLE_PRESET_KEYS.filter((key) => CHALLENGE_PRESET_CATEGORIES[key].group === group)
      .filter((key) => key === currentKey || !usedByOthers.has(key))
      .map((key) => ({ value: key, label: CHALLENGE_PRESET_CATEGORIES[key].label, group }))
  );
}

/**
 * Judging-category editor: Theme is always present and locked; up to 3 more rows can be added,
 * each an unused preset from the curated library (grouped by vibe). `key` and `weight` are the only
 * per-row form state — label + criteria are derived from the key at render (and the server re-derives
 * them too), so no free text reaches the judge and the display can never desync from the selected
 * key. RHF's `judgingCategories` field array is the single source of truth. Renders only the row list
 * + add/total controls — the parent supplies the surrounding "Judging" card.
 */
export default function CategoryWeights() {
  const { control } = useFormContext();
  const { fields, append, remove } = useFieldArray({ control, name: 'judgingCategories' });
  const rows = (useWatch({ control, name: 'judgingCategories' }) as CategoryWeightRow[]) ?? [];

  const total = rows.reduce((sum, row) => sum + (row.weight || 0), 0);
  const hasInvalidRow = rows.some((row) => (row.weight || 0) < 1);
  const isValid = total === 100 && !hasInvalidRow;
  const canAdd = fields.length < MAX_CATEGORIES;

  const addRow = () => {
    const usedKeys = new Set(rows.map((row) => row.key));
    const nextKey = ADDABLE_PRESET_KEYS.find((key) => !usedKeys.has(key));
    if (nextKey) append(makeRow(nextKey));
  };

  return (
    <Stack gap="sm" data-testid="category-weights">
      {fields.map((field, index) => {
        const row = rows[index];
        const isTheme = row?.key === 'theme';
        const criteria = row?.key ? CHALLENGE_PRESET_CATEGORIES[row.key]?.criteria : undefined;
        return (
          <Paper key={field.id} withBorder radius="md" p="sm">
            <Group align="flex-end" wrap="nowrap" gap="sm">
              <InputSelect
                name={`judgingCategories.${index}.key`}
                label="Category"
                data={
                  isTheme
                    ? [{ value: 'theme', label: CHALLENGE_PRESET_CATEGORIES.theme.label }]
                    : keyOptionsFor(index, rows)
                }
                disabled={isTheme}
                allowDeselect={false}
                searchable={!isTheme}
                className="flex-1"
              />
              <InputNumber
                name={`judgingCategories.${index}.weight`}
                label="Weight %"
                min={1}
                max={100}
                step={1}
                allowDecimal={false}
                allowNegative={false}
                clampBehavior="blur"
                className="w-24 shrink-0"
              />
              {isTheme ? (
                <Tooltip label="Theme is required and can't be removed" withArrow>
                  <ActionIcon variant="subtle" color="gray" aria-label="Theme is required" disabled>
                    <IconLock size={16} />
                  </ActionIcon>
                </Tooltip>
              ) : (
                <Tooltip label="Remove category" withArrow>
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    onClick={() => remove(index)}
                    aria-label="Remove category"
                  >
                    <IconX size={16} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
            {criteria && (
              <Text size="xs" c="dimmed" mt="xs" lh={1.4}>
                {criteria}
              </Text>
            )}
          </Paper>
        );
      })}

      <Stack gap={6}>
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Button
            variant="light"
            size="sm"
            leftSection={<IconPlus size={16} />}
            onClick={addRow}
            disabled={!canAdd}
          >
            Add category
          </Button>
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" c="dimmed">
              Total weight
            </Text>
            <Badge size="lg" variant="light" color={isValid ? 'green' : 'red'}>
              {total}%
            </Badge>
          </Group>
        </Group>
        <Progress
          value={Math.min(total, 100)}
          color={isValid ? 'green' : total > 100 ? 'red' : 'yellow'}
          size="sm"
          radius="xl"
        />
        {total !== 100 && (
          <Text size="xs" c="red">
            Weights must total 100% (currently {total}%).
          </Text>
        )}
        {total === 100 && hasInvalidRow && (
          <Text size="xs" c="red">
            Each category needs a weight of at least 1%.
          </Text>
        )}
      </Stack>
    </Stack>
  );
}
