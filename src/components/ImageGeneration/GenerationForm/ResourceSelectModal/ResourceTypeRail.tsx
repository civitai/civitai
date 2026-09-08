import { Text, UnstyledButton } from '@mantine/core';
import { useMemo } from 'react';
import { IconLayersIntersect } from '@tabler/icons-react';
import clsx from 'clsx';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { sortByModelTypes } from '~/utils/array-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import type { ModelType } from '~/shared/utils/prisma/enums';

/**
 * The rail in the `resource` role: the picker's own resource types, promoted
 * out of the filters dropdown so the axis you actually switch on is visible.
 *
 * Its counterpart in the `checkpoint` role is the ecosystem rail, which the
 * form-graph lane passes in — this one needs nothing from the caller, since the
 * allowed types are already in the picker's options.
 */
export function ResourceTypeRail() {
  const { resources, filters, setFilters, role } = useResourceSelectContext();
  // Deduped and ordered the way the filters dropdown does it — options can carry
  // the same `type` twice with different base models, which would otherwise put
  // duplicate rows here under a duplicate React key.
  const types = useMemo(
    () =>
      sortByModelTypes(
        [...new Set(resources.map((r) => r.type as ModelType))].map((modelType) => ({ modelType }))
      ),
    [resources]
  );
  if (role !== 'resource' || types.length < 2) return null;

  const selected = filters.types;

  return (
    <div className="flex min-h-0 w-full flex-col gap-1 overflow-y-auto p-2">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600} className="px-1 pb-1">
        Resource type
      </Text>

      {types.map(({ modelType }) => {
        const type = modelType as ModelType;
        const isSelected = selected.includes(type);
        return (
          <UnstyledButton
            key={type}
            aria-pressed={isSelected}
            onClick={() =>
              setFilters((current) => ({
                ...current,
                // A rail selection is a jump, not an accumulation: picking a type
                // shows that type, picking it again clears back to everything.
                types: isSelected ? [] : [type],
              }))
            }
            className={clsx(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
              isSelected
                ? 'bg-blue-0 font-semibold dark:bg-blue-9/20'
                : 'hover:bg-gray-1 dark:hover:bg-dark-5'
            )}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-gray-2 dark:bg-dark-5">
              <IconLayersIntersect size={13} />
            </span>
            <span className="min-w-0 flex-1 truncate">{getDisplayName(type)}</span>
          </UnstyledButton>
        );
      })}

      <LockedToCheckpointNote />
    </div>
  );
}

/**
 * Says out loud why the catalog is narrower than the site's — the picker is
 * filtered to what loads on the current checkpoint, which otherwise reads as
 * missing models.
 */
function LockedToCheckpointNote() {
  const { resources } = useResourceSelectContext();
  const baseModels = [...new Set(resources.flatMap((r) => r.baseModels))];
  if (!baseModels.length) return null;

  return (
    <div className="mt-3 rounded-lg border border-gray-3 p-2 dark:border-dark-4">
      <Text size="xs" fw={600} className="mb-1">
        Locked to your checkpoint
      </Text>
      <Text size="xs" c="dimmed" className="leading-snug">
        Showing resources that load on {baseModels.slice(0, 3).join(', ')}
        {baseModels.length > 3 ? ` +${baseModels.length - 3} more` : ''}.
      </Text>
    </div>
  );
}
