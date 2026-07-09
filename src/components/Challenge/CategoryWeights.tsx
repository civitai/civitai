import { ActionIcon, Button, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { InputNumber, InputSelect } from '~/libs/form';
import {
  ADDABLE_PRESET_KEYS,
  type CategoryWeightRow,
  CHALLENGE_CATEGORY_GROUPS,
  CHALLENGE_PRESET_CATEGORIES,
  type ChallengeCategoryKey,
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
 * each an unused preset from the curated library (grouped by vibe). Criteria are fixed per preset
 * (shown read-only) — the server re-derives label+criteria from the key, so no free text reaches
 * the judge. RHF's `judgingCategories` field array is the single source of truth. Renders only the
 * row list + add/total controls — the parent supplies the surrounding chrome (the "Judging" card in
 * ChallengeUpsertForm, user variant).
 */
export default function CategoryWeights() {
  const { control } = useFormContext();
  const { fields, append, remove, update } = useFieldArray({ control, name: 'judgingCategories' });
  const rows = (useWatch({ control, name: 'judgingCategories' }) as CategoryWeightRow[]) ?? [];

  const total = rows.reduce((sum, row) => sum + (row.weight || 0), 0);
  const hasInvalidRow = rows.some((row) => row.weight < 1);
  const canAdd = fields.length < MAX_CATEGORIES;

  const handleKeyChange = (index: number, key: ChallengeCategoryKey) => {
    const currentWeight = rows[index]?.weight ?? 0;
    update(index, { ...makeRow(key), weight: currentWeight });
  };

  const addRow = () => {
    const usedKeys = new Set(rows.map((row) => row.key));
    const nextKey = ADDABLE_PRESET_KEYS.find((key) => !usedKeys.has(key));
    if (nextKey) append(makeRow(nextKey));
  };

  return (
    <Stack gap="md">
      {fields.map((field, index) => {
        const row = rows[index];
        const isTheme = row?.key === 'theme';
        return (
          <Stack key={field.id} gap={4}>
            <Group align="flex-end" wrap="nowrap" gap="sm">
              <InputSelect
                name={`judgingCategories.${index}.key`}
                label="Category"
                data={
                  isTheme
                    ? [{ value: 'theme', label: CHALLENGE_PRESET_CATEGORIES.theme.label }]
                    : keyOptionsFor(index, rows)
                }
                onChange={(value: ChallengeCategoryKey) => value && handleKeyChange(index, value)}
                disabled={isTheme}
                allowDeselect={false}
                searchable
                className="w-56 shrink-0"
              />
              <InputNumber
                name={`judgingCategories.${index}.weight`}
                label="Weight"
                min={1}
                max={100}
                step={1}
                allowDecimal={false}
                allowNegative={false}
                clampBehavior="blur"
                className="w-24 shrink-0"
              />
              {!isTheme && (
                <Tooltip label="Remove category">
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
            <Text size="sm" c="dimmed">
              {row?.criteria}
            </Text>
          </Stack>
        );
      })}

      <Group justify="space-between" wrap="wrap">
        <Button
          variant="light"
          size="sm"
          leftSection={<IconPlus size={16} />}
          onClick={addRow}
          disabled={!canAdd}
        >
          Add category
        </Button>
        <Text size="sm" fw={500} c={total === 100 && !hasInvalidRow ? 'dimmed' : 'red'}>
          Total weight: {total}%{total !== 100 ? ' (must equal 100%)' : ''}
          {total === 100 && hasInvalidRow ? ' (each category needs a weight ≥ 1)' : ''}
        </Text>
      </Group>
    </Stack>
  );
}
