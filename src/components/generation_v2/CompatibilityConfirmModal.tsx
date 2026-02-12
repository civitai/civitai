/**
 * CompatibilityConfirmModal
 *
 * A confirmation modal shown when the user selects an incompatible
 * workflow or ecosystem combination.
 */

import { useState, useMemo } from 'react';
import { Button, Card, Group, Modal, Radio, Stack, Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { workflowOptionById } from '~/shared/data-graph/generation/config/workflows';
import {
  ecosystemById,
  ecosystemByKey,
  getEcosystemGroup,
  getEcosystemGroupByKey,
} from '~/shared/constants/basemodel.constants';

// =============================================================================
// Types
// =============================================================================

export type PendingChange =
  | {
      type: 'workflow';
      value: string;
      /** Workflow option ID (e.g., 'img2vid#0' for aliases) */
      optionId: string;
      currentEcosystem: string;
      /** Ecosystem IDs compatible with the selected workflow (per-entry) */
      compatibleEcosystemIds: number[];
      /** Pre-selected ecosystem key (from last-used or default) */
      defaultEcosystemKey: string;
    }
  | {
      type: 'ecosystem';
      value: string;
      ecosystemLabel: string;
      currentWorkflowId: string;
      targetWorkflowId: string;
    };

export interface CompatibilityConfirmModalProps {
  pendingChange: PendingChange;
  onConfirm: (ecosystemKey?: string) => void;
}

// =============================================================================
// Ecosystem Options Helper
// =============================================================================

type EcosystemOption = {
  /** Unique key for this option (group ID or ecosystem key) */
  id: string;
  /** Display name */
  label: string;
  /** The ecosystem key to set when this option is selected */
  ecosystemKey: string;
  /** Sort order for display */
  sortOrder: number;
};

/**
 * Converts a list of ecosystem IDs into grouped display options.
 * Ecosystems in the same group are collapsed into a single option.
 */
function getCompatibleEcosystemOptions(
  ecosystemIds: number[],
  preferredKey?: string
): EcosystemOption[] {
  const seen = new Set<string>();
  const items: EcosystemOption[] = [];

  for (const ecoId of ecosystemIds) {
    const eco = ecosystemById.get(ecoId);
    if (!eco) continue;

    const group = getEcosystemGroup(ecoId);
    if (group) {
      if (seen.has(group.id)) continue;
      seen.add(group.id);

      // Use preferred key if it belongs to this group, otherwise use group default
      const defaultEco = ecosystemById.get(group.defaultEcosystemId);
      let resolvedKey = defaultEco?.key ?? eco.key;

      if (preferredKey) {
        const preferredEco = ecosystemByKey.get(preferredKey);
        if (preferredEco && group.ecosystemIds.includes(preferredEco.id)) {
          resolvedKey = preferredKey;
        }
      }

      items.push({
        id: group.id,
        label: group.displayName,
        ecosystemKey: resolvedKey,
        sortOrder: group.sortOrder,
      });
    } else {
      if (seen.has(eco.key)) continue;
      seen.add(eco.key);
      items.push({
        id: eco.key,
        label: eco.displayName,
        ecosystemKey: eco.key,
        sortOrder: eco.sortOrder ?? 999,
      });
    }
  }

  // Sort: preferred first, then by sortOrder
  return items.sort((a, b) => {
    if (preferredKey) {
      const aIsPreferred = a.ecosystemKey === preferredKey;
      const bIsPreferred = b.ecosystemKey === preferredKey;
      if (aIsPreferred !== bIsPreferred) return aIsPreferred ? -1 : 1;
    }
    return a.sortOrder - b.sortOrder;
  });
}

// =============================================================================
// Dialog Store Component (used internally)
// =============================================================================

function CompatibilityConfirmModalContent({
  pendingChange,
  onConfirm,
}: CompatibilityConfirmModalProps) {
  const dialog = useDialogContext();

  const isWorkflowChange = pendingChange.type === 'workflow';

  // Compute ecosystem options for workflow changes
  const ecosystemOptions = useMemo(() => {
    if (!isWorkflowChange) return [];
    return getCompatibleEcosystemOptions(
      pendingChange.compatibleEcosystemIds,
      pendingChange.defaultEcosystemKey
    );
  }, [isWorkflowChange, pendingChange]);

  const [selectedEcosystemKey, setSelectedEcosystemKey] = useState(() => {
    if (!isWorkflowChange) return '';
    // Find option matching the default, or fall back to first option
    const match = ecosystemOptions.find(
      (o) => o.ecosystemKey === pendingChange.defaultEcosystemKey
    );
    return match?.ecosystemKey ?? ecosystemOptions[0]?.ecosystemKey ?? '';
  });

  // Derive labels from IDs (use optionId for alias-aware lookup like "First/Last Frame")
  const workflowLabel = isWorkflowChange
    ? workflowOptionById.get(pendingChange.optionId)?.label ?? pendingChange.value
    : undefined;

  const currentWorkflowLabel = !isWorkflowChange
    ? workflowOptionById.get(pendingChange.currentWorkflowId)?.label ?? pendingChange.currentWorkflowId
    : undefined;

  const targetWorkflowLabel = !isWorkflowChange
    ? workflowOptionById.get(pendingChange.targetWorkflowId)?.label ?? pendingChange.targetWorkflowId
    : undefined;

  // Resolve ecosystem labels - use group names when available
  const currentEcoLabel = isWorkflowChange
    ? (() => {
        const group = getEcosystemGroupByKey(pendingChange.currentEcosystem);
        return group?.displayName ?? pendingChange.currentEcosystem;
      })()
    : undefined;

  const ecosystemLabel = !isWorkflowChange
    ? (() => {
        const group = getEcosystemGroupByKey(pendingChange.value);
        return group?.displayName ?? pendingChange.ecosystemLabel;
      })()
    : undefined;

  const handleConfirm = () => {
    if (isWorkflowChange) {
      onConfirm(selectedEcosystemKey);
    } else {
      onConfirm();
    }
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      onClose={dialog.onClose}
      title={isWorkflowChange ? 'Change ecosystem?' : 'Change workflow?'}
      size="sm"
      centered
    >
      <Stack gap="md">
        <Text size="sm">
          {isWorkflowChange ? (
            <>
              <strong>{workflowLabel}</strong> is not available for{' '}
              <strong>{currentEcoLabel}</strong>. Select a compatible ecosystem:
            </>
          ) : (
            <>
              <strong>{ecosystemLabel}</strong> doesn&apos;t support{' '}
              <strong>{currentWorkflowLabel}</strong>.
            </>
          )}
        </Text>

        {isWorkflowChange ? (
          <Radio.Group value={selectedEcosystemKey} onChange={setSelectedEcosystemKey}>
            <Stack gap="xs">
              {ecosystemOptions.map((option, index) => (
                <Radio
                  key={option.id}
                  value={option.ecosystemKey}
                  label={option.label}
                />
              ))}
            </Stack>
          </Radio.Group>
        ) : (
          <Card withBorder p="sm" className="bg-gray-0 dark:bg-dark-6">
            <Group gap="sm" wrap="nowrap">
              <Text size="sm" c="dimmed">
                Workflow
              </Text>
              <Text size="sm" fw={500} className="line-through opacity-60">
                {currentWorkflowLabel}
              </Text>
              <IconArrowRight size={14} className="text-gray-5" />
              <Text size="sm" fw={600} c="blue">
                {targetWorkflowLabel}
              </Text>
            </Group>
          </Card>
        )}

        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>Continue</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// =============================================================================
// Trigger Function
// =============================================================================

/**
 * Opens the compatibility confirmation modal via dialogStore.
 * This ensures proper z-index stacking when opened from other modals.
 */
export function openCompatibilityConfirmModal(props: CompatibilityConfirmModalProps) {
  dialogStore.trigger({
    id: 'compatibility-confirm',
    component: CompatibilityConfirmModalContent,
    props,
  });
}
