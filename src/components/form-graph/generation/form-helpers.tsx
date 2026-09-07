import { Input, Menu, Tooltip, UnstyledButton } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo } from 'react';

import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { useResourceDataContext } from '~/components/generation_v2/inputs/ResourceDataProvider';
import { ButtonGroupInput } from '~/libs/form/components/ButtonGroupInput';
import {
  getAllVersionIds,
  type VersionGroup,
  type VersionOption,
} from '~/shared/form-graph/generation/checkpoint';
import type { SnippetsValue } from '~/shared/form-graph/generation/defs';
import { trpc } from '~/utils/trpc';

import type { GenerationStore } from './store';

/**
 * Helpers ported from generation_v2's GenerationForm-local components, on the
 * form-graph store. Same rendering, different state source.
 */

export function ControllerLabel({
  label,
  info,
  required,
}: {
  label: React.ReactNode;
  info?: string;
  required?: boolean;
}) {
  if (!info) return <Input.Label required={required}>{label}</Input.Label>;
  return (
    <div className="flex items-center gap-1">
      <Input.Label>{label}</Input.Label>
      <InfoPopover size="xs" iconProps={{ size: 14 }}>
        {info}
      </InfoPopover>
      {required && <span className="text-red-5">*</span>}
    </div>
  );
}

/** Path through a VersionGroup tree matching a model ID, root to leaf. */
function findModelPath(group: VersionGroup, modelId: number): VersionOption[] | null {
  for (const opt of group.options) {
    if (opt.children) {
      const subPath = findModelPath(opt.children, modelId);
      if (subPath) return [opt, ...subPath];
    } else if (opt.value === modelId) {
      return [opt];
    }
  }
  return null;
}

function VersionLevelDropdown({
  group,
  selectedValue,
  onChange,
}: {
  group: VersionGroup;
  selectedValue: number;
  onChange: (id: number) => void;
}) {
  const selected = group.options.find((o) => o.value === selectedValue) ?? group.options[0];
  return (
    <Menu position="bottom-start" withinPortal>
      <Tooltip label={group.label} position="top" withArrow disabled={!group.label}>
        <Menu.Target>
          <UnstyledButton
            className={clsx(
              'flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold',
              'bg-gray-1 hover:bg-gray-2',
              'dark:bg-dark-5 dark:hover:bg-dark-4'
            )}
          >
            {selected?.label}
          </UnstyledButton>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown>
        {group.options.map((option) => (
          <Menu.Item
            key={option.value}
            onClick={() => onChange(option.value)}
            className={clsx(selectedValue === option.value && 'bg-blue-5/10 dark:bg-blue-8/20')}
          >
            {option.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * Hierarchical version selector — parent levels as compact dropdowns, leaf as
 * a button group. Registers every version id with ResourceDataProvider for
 * batch hydration.
 */
export function VersionGroupSelector({
  versions,
  modelId,
  onChange,
}: {
  versions: VersionGroup;
  modelId: number | undefined;
  onChange: (value: { id: number }) => void;
}) {
  const allIds = useMemo(() => getAllVersionIds(versions), [versions]);
  const { registerResourceId, unregisterResourceId, getResourceData } = useResourceDataContext();

  useEffect(() => {
    if (allIds.size === 0) return;
    allIds.forEach(registerResourceId);
    return () => {
      allIds.forEach(unregisterResourceId);
    };
  }, [allIds, registerResourceId, unregisterResourceId]);

  const handleChange = useCallback(
    (id: number) => {
      const resourceData = getResourceData(id);
      onChange(resourceData ?? { id });
    },
    [getResourceData, onChange]
  );

  if (!modelId || !allIds.has(modelId) || allIds.size <= 1) return null;

  const path = findModelPath(versions, modelId);

  const levels: Array<{ group: VersionGroup; selectedValue: number }> = [];
  let currentGroup: VersionGroup | undefined = versions;
  let pathIdx = 0;
  while (currentGroup && currentGroup.options.length > 0) {
    const selected: VersionOption = path?.[pathIdx] ?? currentGroup.options[0];
    levels.push({ group: currentGroup, selectedValue: selected.value });
    currentGroup = selected.children;
    pathIdx++;
  }

  const leaf = levels[levels.length - 1];

  return (
    <div className="flex items-center gap-1">
      {levels.slice(0, -1).map((level, i) => (
        <VersionLevelDropdown
          key={level.group.label ?? i}
          group={level.group}
          selectedValue={level.selectedValue}
          onChange={handleChange}
        />
      ))}
      {leaf && (
        <ButtonGroupInput
          className="flex-1"
          value={leaf.selectedValue.toString()}
          onChange={(v) => handleChange(Number(v))}
          data={leaf.group.options.map((o) => ({ label: o.label, value: o.value.toString() }))}
        />
      )}
    </div>
  );
}

/** The wildcard-set add/remove flow, against the form-graph store. */
export function useWildcardHandlers(store: GenerationStore) {
  const loadFromModelVersion = trpc.wildcardSet.loadFromModelVersion.useMutation();

  const readSnippets = () => (store.getSnapshot().state as { snippets?: SnippetsValue }).snippets;

  const removeWildcardSet = useCallback(
    (id: number) => {
      const current = readSnippets();
      if (!current) return;
      store.set({
        snippets: { ...current, wildcardSetIds: current.wildcardSetIds.filter((x) => x !== id) },
      });
    },
    [store] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const addWildcardSet = useCallback(() => {
    openResourceSelectModal({
      title: 'Add wildcard set',
      selectSource: 'addResource',
      options: { resources: [{ type: 'Wildcards' }] },
      onSelect: async (resource) => {
        try {
          const result = await loadFromModelVersion.mutateAsync({ modelVersionId: resource.id });
          const current = readSnippets() ?? {
            wildcardSetIds: [],
            mode: 'random' as const,
            batchCount: 1,
            targets: {},
          };
          if (current.wildcardSetIds.includes(result.wildcardSetId)) return;
          store.set({
            snippets: {
              ...current,
              wildcardSetIds: [...current.wildcardSetIds, result.wildcardSetId],
            },
          });
          if (result.invalidated) {
            showNotification({
              title: 'Wildcard set added with warnings',
              message:
                result.reason ?? 'The set was added but its content is currently invalidated.',
              color: 'yellow',
            });
          }
        } catch (e) {
          showNotification({
            title: 'Could not add wildcard set',
            message: e instanceof Error ? e.message : String(e),
            color: 'red',
          });
        }
      },
    });
  }, [store, loadFromModelVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  return { removeWildcardSet, addWildcardSet, isAdding: loadFromModelVersion.isPending };
}
