import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Badge, Group, Text, Tooltip } from '@mantine/core';
import {
  IconArrowBackUp,
  IconBookmark,
  IconCopyPlus,
  IconDeviceFloppy,
  IconX,
} from '@tabler/icons-react';

import { dialogStore } from '~/components/Dialog/dialogStore';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { SavePresetModal } from '~/components/generation_v2/preset/SavePresetModal';
import { applyPreset } from '~/components/generation_v2/preset/applyPreset';
import { useGraph } from '~/libs/data-graph/react';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';
import {
  filterPresetValues,
  isPresetDirty,
  useGenerationPresetStore,
  type PresetValues,
} from '~/store/generation-preset.store';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type EcosystemLike = { ecosystem?: string };

/**
 * Hook: publishes the current graph's ecosystem + snapshot-getter to the
 * preset store so the header button (which lives outside the graph context)
 * can use them.
 */
function usePresetGraphBridge(graph: ReturnType<typeof useGraph<GenerationGraphTypes>>) {
  const setBridge = useGenerationPresetStore((s) => s.setBridge);
  const clearBridge = useGenerationPresetStore((s) => s.clearBridge);

  useEffect(() => {
    const getFilteredSnapshot = (): PresetValues =>
      filterPresetValues(
        graph.getSnapshot() as Record<string, unknown>,
        (k) => graph.isComputed(k as never)
      );
    const readEcosystem = () =>
      (graph.getSnapshot() as EcosystemLike).ecosystem ?? null;

    setBridge({ ecosystem: readEcosystem(), getFilteredSnapshot });

    type LooseGraph = { subscribe: (key: string, cb: () => void) => () => void };
    const unsub = (graph as LooseGraph).subscribe('ecosystem', () => {
      setBridge({ ecosystem: readEcosystem() });
    });

    return () => {
      unsub();
      clearBridge();
    };
  }, [graph, setBridge, clearBridge]);
}

function useGraphChangeCounter(graph: ReturnType<typeof useGraph<GenerationGraphTypes>>) {
  const [counter, setCounter] = useState(0);
  useEffect(() => graph.subscribe(() => setCounter((c) => c + 1)), [graph]);
  return counter;
}

/**
 * Active-preset indicator. Renders only when a preset is loaded. Shows the
 * preset name, a dirty indicator, and icons for Save / Save-as / Close.
 * The trigger button lives separately in the generation tabs header — see
 * `PresetHeaderButton`.
 */
export function PresetControl() {
  const graph = useGraph<GenerationGraphTypes>();
  usePresetGraphBridge(graph);

  const changeCounter = useGraphChangeCounter(graph);
  const filteredSnapshot = useMemo(
    () =>
      filterPresetValues(
        graph.getSnapshot() as Record<string, unknown>,
        (k) => graph.isComputed(k as never)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- changeCounter forces recompute
    [graph, changeCounter]
  );

  const activePresetId = useGenerationPresetStore((s) => s.activePresetId);
  const activePresetName = useGenerationPresetStore((s) => s.activePresetName);
  const activePresetValues = useGenerationPresetStore((s) => s.activePresetValues);
  const closePreset = useGenerationPresetStore((s) => s.closePreset);
  const markClean = useGenerationPresetStore((s) => s.markClean);

  const isDirty = useMemo(
    () => isPresetDirty(activePresetValues, filteredSnapshot, (k) => graph.isComputed(k as never)),
    [activePresetValues, filteredSnapshot, graph]
  );

  const utils = trpc.useUtils();
  const updatePreset = trpc.generationPreset.update.useMutation({
    onSuccess: async (preset) => {
      showSuccessNotification({ title: 'Preset updated', message: `Saved "${preset.name}"` });
      markClean(preset.values as PresetValues);
      await utils.generationPreset.getForEcosystem.invalidate();
      await utils.generationPreset.getOwn.invalidate();
    },
    onError: (err) =>
      showErrorNotification({
        title: 'Failed to update preset',
        error: new Error(err.message),
      }),
  });

  if (activePresetId === null || !activePresetName) return null;

  const openSaveAs = () => {
    const values = { ...filteredSnapshot };
    if (!values.ecosystem) return;
    dialogStore.trigger({ id: 'save-preset', component: SavePresetModal });
  };

  const handleSaveDirty = () => {
    if (!activePresetId) return;
    const values = { ...filteredSnapshot };
    if (!values.ecosystem) return;
    updatePreset.mutate({ id: activePresetId, values });
  };

  const handleReset = () => {
    if (!activePresetId || !activePresetName || !activePresetValues) return;
    applyPreset({
      id: activePresetId,
      name: activePresetName,
      values: activePresetValues,
    }).catch((err: Error) =>
      showErrorNotification({ title: 'Failed to reset preset', error: err })
    );
  };

  return (
    <Group
      gap="xs"
      className="rounded border border-gray-3 bg-gray-0 px-2 py-1 dark:border-dark-4 dark:bg-dark-6"
    >
      <IconBookmark size={14} />
      <Text size="sm" fw={500} lineClamp={1} className="flex-1">
        {activePresetName}
      </Text>
      {isDirty && (
        <>
          <Badge size="xs" color="yellow" variant="light">
            Modified
          </Badge>
          <PopConfirm
            message="Update preset with current values?"
            onConfirm={handleSaveDirty}
          >
            <Tooltip label="Save" withArrow>
              <ActionIcon
                variant="subtle"
                size="sm"
                color="blue"
                disabled={updatePreset.isLoading}
                loading={updatePreset.isLoading}
              >
                <IconDeviceFloppy size={16} />
              </ActionIcon>
            </Tooltip>
          </PopConfirm>
          <Tooltip label="Save as new preset" withArrow>
            <ActionIcon variant="subtle" size="sm" onClick={openSaveAs}>
              <IconCopyPlus size={16} />
            </ActionIcon>
          </Tooltip>
          <PopConfirm
            message="Discard changes and reset to preset?"
            onConfirm={handleReset}
          >
            <Tooltip label="Reset to preset" withArrow>
              <ActionIcon variant="subtle" size="sm" color="gray">
                <IconArrowBackUp size={16} />
              </ActionIcon>
            </Tooltip>
          </PopConfirm>
        </>
      )}
      <Tooltip label="Close preset" withArrow>
        <ActionIcon variant="subtle" size="sm" color="gray" onClick={closePreset}>
          <IconX size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
