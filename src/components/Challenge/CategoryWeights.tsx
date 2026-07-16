import { ActionIcon, Badge, Button, Group, Paper, Progress, Stack, Text, Tooltip } from '@mantine/core';
import { IconLock, IconPlus, IconX } from '@tabler/icons-react';
import { useMemo } from 'react';
import { useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { InputNumber, InputSelect } from '~/libs/form';
import {
  type CategoryWeightRow,
  CHALLENGE_CATEGORY_KEYS,
  CHALLENGE_PRESET_CATEGORIES,
  MAX_CATEGORIES,
} from '~/shared/constants/challenge.constants';
import { trpc } from '~/utils/trpc';

type CategoryOption = { key: string; label: string; group: string; criteria: string };

// Shown until the DB-backed library loads (and if the query fails) so the form is never empty.
// The server falls back to the same presets when its ChallengeCategory table is unseeded.
const PRESET_FALLBACK_OPTIONS: CategoryOption[] = CHALLENGE_CATEGORY_KEYS.map((key) => ({
  key,
  ...CHALLENGE_PRESET_CATEGORIES[key],
}));

// Build the grouped Select options for one row: every category the row may switch to — its own key
// plus any category not already used by another row. Returns a flat, group-tagged list (InputSelect
// groups by the `group` field itself); the server returns rows in sortOrder, so first-seen group
// order is stable. A row whose stored key is no longer in the library (deactivated category on an
// old challenge) keeps a synthetic option so the Select doesn't blank out.
function keyOptionsFor(index: number, rows: CategoryWeightRow[], addable: CategoryOption[]) {
  const row = rows[index];
  const currentKey = row?.key;
  const usedByOthers = new Set(rows.filter((_, i) => i !== index).map((r) => r.key));
  const options = addable
    .filter((c) => c.key === currentKey || !usedByOthers.has(c.key))
    .map((c) => ({ value: c.key, label: c.label, group: c.group }));
  if (currentKey && !options.some((o) => o.value === currentKey))
    options.unshift({ value: currentKey, label: row?.label || currentKey, group: 'Other' });
  return options;
}

/**
 * Judging-category editor: Theme is always present and locked; up to 3 more rows can be added,
 * each an unused category from the library (grouped by vibe, fetched from the server). `key` and
 * `weight` are the only per-row form state — label + criteria are derived from the key at render
 * (and the server re-derives them too), so no free text reaches the judge and the display can
 * never desync from the selected key. RHF's `judgingCategories` field array is the single source
 * of truth. Renders only the row list + add/total controls — the parent supplies the surrounding
 * "Judging" card.
 */
export default function CategoryWeights({ disabled = false }: { disabled?: boolean }) {
  const { control } = useFormContext();
  const { fields, append, remove } = useFieldArray({ control, name: 'judgingCategories' });
  const rows = (useWatch({ control, name: 'judgingCategories' }) as CategoryWeightRow[]) ?? [];

  const { data: fetchedCategories } = trpc.challenge.getJudgingCategories.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const categories = fetchedCategories ?? PRESET_FALLBACK_OPTIONS;
  const categoryByKey = useMemo(
    () => new Map(categories.map((c) => [c.key, c])),
    [categories]
  );
  const addable = useMemo(() => categories.filter((c) => c.key !== 'theme'), [categories]);

  const total = rows.reduce((sum, row) => sum + (row.weight || 0), 0);
  const hasInvalidRow = rows.some((row) => (row.weight || 0) < 1);
  const isValid = total === 100 && !hasInvalidRow;
  const canAdd = fields.length < MAX_CATEGORIES;

  const addRow = () => {
    const usedKeys = new Set(rows.map((row) => row.key));
    const next = addable.find((c) => !usedKeys.has(c.key));
    if (next) append({ key: next.key, label: next.label, criteria: next.criteria, weight: 0 });
  };

  return (
    <Stack gap="sm" data-testid="category-weights">
      {fields.map((field, index) => {
        const row = rows[index];
        const isTheme = row?.key === 'theme';
        const criteria = row?.key
          ? categoryByKey.get(row.key)?.criteria ?? row.criteria
          : undefined;
        return (
          <Paper key={field.id} withBorder radius="md" p="sm">
            <Group align="flex-end" wrap="nowrap" gap="sm">
              <InputSelect
                name={`judgingCategories.${index}.key`}
                label="Category"
                data={
                  isTheme
                    ? [{ value: 'theme', label: categoryByKey.get('theme')?.label ?? 'Theme' }]
                    : keyOptionsFor(index, rows, addable)
                }
                disabled={isTheme || disabled}
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
                clampBehavior="none"
                className="w-24 shrink-0"
                disabled={disabled}
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
                    disabled={disabled}
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
            disabled={!canAdd || disabled}
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
