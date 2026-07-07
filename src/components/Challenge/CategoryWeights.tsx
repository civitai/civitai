import { ActionIcon, Button, Group, NumberInput, Select, Stack, Text, Tooltip } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import {
  CHALLENGE_CATEGORY_GROUPS,
  CHALLENGE_CATEGORY_KEYS,
  CHALLENGE_PRESET_CATEGORIES,
  type ChallengeCategoryKey,
} from '~/shared/constants/challenge.constants';

export type CategoryWeightRow = {
  key: ChallengeCategoryKey;
  label: string;
  criteria: string;
  weight: number;
};

const MAX_CATEGORIES = 4;
// Presets a non-Theme row may pick; Theme is reserved for the always-present first row.
const ADDABLE_PRESET_KEYS = CHALLENGE_CATEGORY_KEYS.filter((key) => key !== 'theme');

function makeRow(key: ChallengeCategoryKey): CategoryWeightRow {
  const preset = CHALLENGE_PRESET_CATEGORIES[key];
  return { key, label: preset.label, criteria: preset.criteria, weight: 0 };
}

// Default starting categories mirror the daily rubric split (theme 50 / wittiness 15 / humor 15 /
// aesthetic 20 = 100) so a creator has a sensible default without configuring anything. Theme stays
// first + non-removable; the other three are freely editable or removable.
const DEFAULT_CATEGORY_ROWS: CategoryWeightRow[] = [
  { ...makeRow('theme'), weight: 50 },
  { ...makeRow('wittiness'), weight: 15 },
  { ...makeRow('humor'), weight: 15 },
  { ...makeRow('aesthetic'), weight: 20 },
];

type LocalRow = CategoryWeightRow & { id: number };

// Build the grouped Select options for one row: every category the row may switch to — its own key
// plus any preset not already used by another row — grouped by vibe. Empty groups are dropped.
function keyOptionsFor(row: LocalRow, rows: LocalRow[]) {
  const usedByOthers = new Set(rows.filter((r) => r.id !== row.id).map((r) => r.key));
  return CHALLENGE_CATEGORY_GROUPS.map((group) => ({
    group,
    items: ADDABLE_PRESET_KEYS.filter((key) => CHALLENGE_PRESET_CATEGORIES[key].group === group)
      .filter((key) => key === row.key || !usedByOthers.has(key))
      .map((key) => ({ value: key, label: CHALLENGE_PRESET_CATEGORIES[key].label })),
  })).filter((g) => g.items.length > 0);
}

/**
 * Judging-category editor: Theme is always present and locked; up to 3 more rows can be added,
 * each an unused preset from the curated library (grouped by vibe). Criteria are fixed per preset
 * (shown read-only) — the server re-derives label+criteria from the key, so no free text reaches
 * the judge. Writes the assembled array to the ambient RHF form's `judgingCategories` field on
 * every change. Renders only the row list + add/total controls — the parent supplies the
 * surrounding chrome (the "Judging" card in ChallengeUpsertForm, user variant).
 */
export default function CategoryWeights() {
  const { setValue, watch } = useFormContext();
  const existing = watch('judgingCategories') as CategoryWeightRow[] | undefined;
  const nextId = useRef(0);
  const withId = (row: CategoryWeightRow): LocalRow => ({ ...row, id: nextId.current++ });

  const [rows, setRows] = useState<LocalRow[]>(() => {
    if (existing?.length) return existing.map(withId);
    return DEFAULT_CATEGORY_ROWS.map(withId);
  });

  useEffect(() => {
    const assembled: CategoryWeightRow[] = rows.map((row) => ({
      key: row.key,
      label: row.label,
      criteria: row.criteria,
      weight: row.weight,
    }));
    setValue('judgingCategories', assembled, { shouldValidate: true, shouldDirty: true });
  }, [rows, setValue]);

  const total = rows.reduce((sum, row) => sum + (row.weight || 0), 0);
  const hasInvalidRow = rows.some((row) => row.weight < 1);
  const canAdd = rows.length < MAX_CATEGORIES;

  const updateRow = (id: number, patch: Partial<CategoryWeightRow>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const removeRow = (id: number) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
  };

  const addRow = () => {
    const usedKeys = new Set(rows.map((row) => row.key));
    const nextKey = ADDABLE_PRESET_KEYS.find((key) => !usedKeys.has(key));
    if (nextKey) setRows((prev) => [...prev, withId(makeRow(nextKey))]);
  };

  const handleKeyChange = (id: number, key: ChallengeCategoryKey) => {
    const next = makeRow(key);
    updateRow(id, { key: next.key, label: next.label, criteria: next.criteria });
  };

  return (
    <Stack gap="md">
      {rows.map((row) => {
        const isTheme = row.key === 'theme';
        return (
          <Stack key={row.id} gap={4}>
            <Group align="flex-end" wrap="nowrap" gap="sm">
              <Select
                label="Category"
                data={
                  isTheme
                    ? [{ value: 'theme', label: CHALLENGE_PRESET_CATEGORIES.theme.label }]
                    : keyOptionsFor(row, rows)
                }
                value={row.key}
                onChange={(value) => value && handleKeyChange(row.id, value as ChallengeCategoryKey)}
                disabled={isTheme}
                allowDeselect={false}
                searchable
                className="w-56 shrink-0"
              />
              <NumberInput
                label="Weight"
                min={1}
                max={100}
                step={1}
                allowDecimal={false}
                allowNegative={false}
                clampBehavior="blur"
                value={row.weight}
                onChange={(value) =>
                  updateRow(row.id, { weight: typeof value === 'number' ? Math.trunc(value) : 0 })
                }
                className="w-24 shrink-0"
              />
              {!isTheme && (
                <Tooltip label="Remove category">
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    onClick={() => removeRow(row.id)}
                    aria-label="Remove category"
                  >
                    <IconX size={16} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
            <Text size="sm" c="dimmed">
              {row.criteria}
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
