/**
 * WorkflowPicker
 *
 * The generator's workflow control: the selected workflow, opening a picker of every workflow by
 * category.
 */

import { Badge, Group, Text, UnstyledButton, Stack } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import {
  IconArrowLeft,
  IconCheck,
  IconChevronDown,
  IconCube,
  IconMusic,
  IconPhoto,
  IconVideo,
  IconDiamond,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactElement } from 'react';
import { cloneElement, useMemo, useState } from 'react';

import { ChoiceGroup } from '~/libs/form/components/ChoiceGroup';
import { PopoverOrSheet } from '~/components/generation_v2/PopoverOrSheet';
import { useGeneratorLayout } from '~/hooks/useMobileGenerator';
import { RequireMembership } from '~/components/RequireMembership/RequireMembership';
import { SupportButtonPolymorphic } from '~/components/SupportButton/SupportButton';
import {
  workflowOptionById,
  workflowConfigByKey,
  getWorkflowLabelForEcosystem,
} from '~/shared/generation/config/workflows';
import type { WorkflowCategory } from '~/shared/generation/config/types';
import type { GateItemState } from '~/shared/generation/gates';
import { ExperimentalFlask } from '~/components/generation_v2/Experimental';
import {
  useAvailableWorkflowGroups,
  useWorkflowGateStates,
} from '~/components/generation_v2/inputs/workflow-visibility';

// =============================================================================
// Types
// =============================================================================

export interface WorkflowOption {
  id: string;
  label: string;
  description?: string;
  compatible: boolean;
  memberOnly?: boolean;
  isNew?: boolean;
}

export interface WorkflowCategoryGroup {
  category: string;
  label: string;
  workflows: WorkflowOption[];
}

export interface WorkflowPickerProps {
  /** Graph workflow key (e.g., 'img2vid') */
  value?: string;
  /** Called with (graphKey, ecosystemIds, optionId) when user selects a workflow */
  onChange?: (graphKey: string, ecosystemIds: number[], optionId: string) => void;
  /** Current ecosystem ID — used to highlight the correct alias entry */
  ecosystemId?: number;
  /** Check if a workflow option is compatible with the current ecosystem */
  isCompatible?: (optionId: string) => boolean;
  /** Whether the current user is a member */
  isMember?: boolean;
  onBack?: () => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Resolve which option to highlight based on the graph key and current ecosystem.
 * For aliases (multiple options with same graphKey), picks the one matching the ecosystem.
 */
function getSelectedWorkflow(
  options: WorkflowCategoryGroup[],
  graphKey?: string,
  ecosystemId?: number
): { workflow: WorkflowOption; category: WorkflowCategoryGroup } | undefined {
  if (!graphKey) return undefined;

  // Collect all candidates matching this graphKey
  const candidates: { workflow: WorkflowOption; category: WorkflowCategoryGroup }[] = [];
  for (const category of options) {
    for (const workflow of category.workflows) {
      const optionGraphKey = workflowOptionById.get(workflow.id)?.graphKey ?? workflow.id;
      if (optionGraphKey === graphKey) {
        candidates.push({ workflow, category });
      }
    }
  }

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // Multiple candidates — pick the one whose ecosystemIds include the current ecosystem
  if (ecosystemId !== undefined) {
    for (const c of candidates) {
      const opt = workflowOptionById.get(c.workflow.id);
      if (opt?.ecosystemIds.includes(ecosystemId)) return c;
    }
  }
  return candidates[0];
}

// =============================================================================
// Workflow Menu Item
// =============================================================================

interface WorkflowMenuItemProps {
  workflow: WorkflowOption;
  isSelected: boolean;
  onSelect: () => void;
  /** Whether this workflow is compatible with the current ecosystem */
  isCompatible?: boolean;
  /** Whether the current user is a member */
  isMember?: boolean;
  /**
   * Gate state from the unified resolver (legacy `disabledWorkflows` + rules).
   * `disabled` → greyed "Disabled" badge; `memberOnly` → the membership upsell
   * (same path as a workflow's own `memberOnly` flag). Hidden keys are filtered
   * out upstream, so they never reach here.
   */
  gateState?: GateItemState['state'];
  /** Optional rule message layered on the gate state's standard tooltip/upsell. */
  gateMessage?: string;
}

function WorkflowMenuItem({
  workflow,
  isSelected,
  onSelect,
  isCompatible = true,
  isMember = false,
  gateState,
  gateMessage,
}: WorkflowMenuItemProps) {
  // Rule-disabled stays SELECTABLE, badged and dimmed: picking it is how the
  // form gets to explain why generation is blocked (mirrors BaseModelInput).
  if (gateState === 'disabled') {
    return (
      <Tooltip
        label={gateMessage ?? 'This workflow is currently unavailable'}
        position="right"
        withArrow
        openDelay={300}
      >
        <UnstyledButton
          onClick={onSelect}
          className="w-full rounded-md px-3 py-2.5 opacity-60 hover:bg-gray-1 dark:hover:bg-dark-4"
        >
          <Group gap="sm" wrap="nowrap" justify="space-between">
            <div className="min-w-0 flex-1">
              <Text size="sm">{workflow.label}</Text>
              {workflow.description && (
                <Text size="xs" c="dimmed" className="mt-0.5">
                  {workflow.description}
                </Text>
              )}
            </div>
            <Badge size="xs" color="gray" variant="light">
              Disabled
            </Badge>
          </Group>
        </UnstyledButton>
      </Tooltip>
    );
  }

  // Upsell when the workflow is member-only — either by its own config flag (for
  // non-members) or by a `memberOnly` gate rule (already audience-filtered to
  // non-members server-side, so it always upsells here).
  const showMembership = gateState === 'memberOnly' || (workflow.memberOnly && !isMember);

  if (showMembership) {
    return (
      <RequireMembership>
        <SupportButtonPolymorphic
          position="right"
          className="!h-auto !min-h-[44px] w-full !px-3 !py-2.5"
        >
          <div className="flex flex-col items-start gap-0.5 py-0.5">
            <span className="flex items-center gap-1 text-sm leading-tight">
              {workflow.label}
              <IconDiamond size={14} className="shrink-0" />
              {workflow.isNew && (
                <Badge size="xs" color="green" variant="filled" radius="sm">
                  New
                </Badge>
              )}
            </span>
            {workflow.description && (
              <span className="text-dimmed text-xs leading-tight opacity-70">
                {workflow.description}
              </span>
            )}
          </div>
        </SupportButtonPolymorphic>
      </RequireMembership>
    );
  }

  return (
    <UnstyledButton
      onClick={onSelect}
      className={clsx(
        'w-full rounded-md px-3 py-2.5 text-left transition-colors',
        isSelected ? 'bg-blue-0 dark:bg-blue-9/20' : 'hover:bg-gray-1 dark:hover:bg-dark-4'
      )}
    >
      <Group gap="sm" wrap="nowrap" justify="space-between">
        <div className="min-w-0 flex-1">
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={isSelected ? 600 : 400}>
              {workflow.label}
            </Text>
            {/* Gate targets are keyed by graphKey; an alias resolves to its parent. */}
            <ExperimentalFlask
              target={{
                kind: 'workflow',
                key: workflowOptionById.get(workflow.id)?.graphKey ?? workflow.id,
              }}
              size={16}
            />
            {workflow.isNew && (
              <Badge size="xs" color="green" variant="filled" radius="sm">
                New
              </Badge>
            )}
          </Group>
          {workflow.description && (
            <Text size="xs" c="dimmed" className="mt-0.5">
              {workflow.description}
            </Text>
          )}
        </div>
        {isSelected && <IconCheck size={16} className="shrink-0 text-blue-6" />}
      </Group>
    </UnstyledButton>
  );
}

/**
 * Capped to the viewport so a long list scrolls instead of running off the bottom. A step lighter
 * than the generator's cards (the fields' shade), so it stands off the form it opens over.
 */
const DROPDOWN_CLASS = 'max-h-[70vh] overflow-y-auto bg-white dark:bg-dark-5';

const SEGMENTS: {
  category: WorkflowCategory;
  icon: ReactElement<{ size?: number }>;
  label: string;
  /** The category's colour, on its icon and its tag. Whole class names, so Tailwind finds them. */
  tone: string;
}[] = [
  {
    category: 'image',
    icon: <IconPhoto size={16} />,
    label: 'Image',
    tone: 'bg-blue-0 text-blue-6 dark:bg-blue-9/20 dark:text-blue-4',
  },
  {
    category: 'video',
    icon: <IconVideo size={16} />,
    label: 'Video',
    tone: 'bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300',
  },
  {
    category: 'audio',
    icon: <IconMusic size={16} />,
    label: 'Audio',
    tone: 'bg-green-0 text-green-7 dark:bg-green-9/20 dark:text-green-4',
  },
  {
    category: 'model3d',
    icon: <IconCube size={16} />,
    label: '3D Models',
    tone: 'bg-orange-0 text-orange-7 dark:bg-orange-9/20 dark:text-orange-4',
  },
];

/** The category segments to offer, each with its workflows. */
function getVisibleSegments(options: WorkflowCategoryGroup[]) {
  return (
    SEGMENTS.map((segment) => ({
      ...segment,
      categories: options.filter((cat) => cat.category === segment.category),
    }))
      // Image always shows; the others only when they have a workflow to offer.
      .filter(
        (segment) =>
          segment.category === 'image' || segment.categories.some((cat) => cat.workflows.length > 0)
      )
  );
}

/** A workflow's display option and label, a variant resolved to its parent ("img2vid:first-last" shows as "Image to Video"). */
function resolveWorkflowDisplay(workflowId: string | undefined, ecosystemId?: number) {
  const resolvedId = workflowId
    ? workflowConfigByKey.get(workflowId)?.variantOf ?? workflowId
    : undefined;
  const workflow = resolvedId ? workflowOptionById.get(resolvedId) : undefined;
  if (!resolvedId || !workflow) return undefined;
  return { workflow, label: getWorkflowLabelForEcosystem(resolvedId, ecosystemId) };
}

// =============================================================================
// Workflow List Content (shared between Popover and Modal)
// =============================================================================

interface WorkflowListContentProps {
  categories: WorkflowCategoryGroup[];
  selectedValue?: string;
  onSelect: (graphKey: string, ecosystemIds: number[], optionId: string) => void;
  isCompatible?: (optionId: string) => boolean;
  isMember?: boolean;
}

function WorkflowListContent({
  categories,
  selectedValue,
  onSelect,
  isCompatible,
  isMember = false,
}: WorkflowListContentProps) {
  // Workflow gate state from the gate rules. Read here so both the desktop
  // popover and the dialogStore modal that share this renderer get them. Mirrors
  // the workflow node's resolver so client + server agree: hidden keys drop out
  // of the list, the rest carry a per-state badge.
  const { hiddenSet, stateMap } = useWorkflowGateStates();

  // Flatten all workflows with compatibility + gate info, dropping hidden keys.
  const allWorkflows = useMemo(() => {
    const workflows: Array<{
      workflow: WorkflowOption;
      compatible: boolean;
      gate?: GateItemState;
    }> = [];

    for (const category of categories) {
      for (const workflow of category.workflows) {
        // The gate maps hold graphKeys; resolve the option's graphKey (an
        // alias's graphKey points to its parent) before checking.
        const graphKey = workflowOptionById.get(workflow.id)?.graphKey ?? workflow.id;
        if (hiddenSet.has(graphKey)) continue;
        const compatible = isCompatible?.(workflow.id) ?? true;
        workflows.push({ workflow, compatible, gate: stateMap.get(graphKey) });
      }
    }

    return workflows;
  }, [categories, isCompatible, hiddenSet, stateMap]);

  return (
    <Stack gap={2}>
      {allWorkflows.map(({ workflow, compatible, gate }) => (
        <WorkflowMenuItem
          key={workflow.id}
          workflow={workflow}
          isSelected={workflow.id === selectedValue}
          onSelect={() => {
            const opt = workflowOptionById.get(workflow.id);
            onSelect(opt?.graphKey ?? workflow.id, opt?.ecosystemIds ?? [], workflow.id);
          }}
          isCompatible={compatible}
          isMember={isMember}
          gateState={gate?.state}
          gateMessage={gate?.message}
        />
      ))}
    </Stack>
  );
}

// =============================================================================
// Workflow Picker
// =============================================================================

/**
 * The selected workflow as a row that opens every workflow, by category: a popover, or a sheet on
 * a phone. Drawn without an outline of its own: it heads the workflow card.
 */
export function WorkflowPicker({
  value,
  onChange,
  ecosystemId,
  isCompatible,
  isMember = false,
  onBack,
}: WorkflowPickerProps) {
  const [opened, setOpened] = useState(false);
  // Off a phone there is room to say what the workflow does.
  const describe = useGeneratorLayout() !== 'mobile';
  const options = useAvailableWorkflowGroups();
  const selected = getSelectedWorkflow(options, value, ecosystemId);
  const display = resolveWorkflowDisplay(value, ecosystemId);
  const category = selected?.category.category ?? display?.workflow.category ?? 'image';
  const [tab, setTab] = useState(category);

  const segments = getVisibleSegments(options);
  const segment = segments.find((s) => s.category === category) ?? segments[0];
  if (!display) return null;
  const { label, workflow } = display;

  return (
    <div className="flex items-center gap-2">
      {onBack && (
        <UnstyledButton
          onClick={onBack}
          data-tap-target
          className="flex shrink-0 items-center rounded p-1 text-gray-6 dark:text-dark-2"
          aria-label="Back to previous workflow"
        >
          <IconArrowLeft size={20} />
        </UnstyledButton>
      )}
      <PopoverOrSheet
        opened={opened}
        onClose={() => setOpened(false)}
        title="Choose a workflow"
        narrow="fullscreen"
        tall
        popoverProps={{
          position: 'bottom-end',
          width: 'target',
          shadow: 'xl',
          // Flush with the button: Mantine's default gap shows the card's mode buttons through it.
          offset: 0,
          // On a wide panel the cap leaves it hanging under Change. A styles prop, not a class: the
          // theme sets the dropdown's max-width inline.
          styles: { dropdown: { maxWidth: 380 } },
        }}
        dropdownProps={{ p: 'xs', className: DROPDOWN_CLASS }}
        target={
          <button
            type="button"
            onClick={() => {
              if (opened) return setOpened(false);
              setTab(category);
              setOpened(true);
            }}
            aria-label={`Workflow: ${label}. Change workflow`}
            className="flex w-full min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent p-2 text-left font-[inherit] text-inherit"
          >
            {/* Sized to line up with the model's thumbnail in the card beneath. */}
            <span
              className={clsx(
                'flex size-10 shrink-0 items-center justify-center rounded-md',
                segment.tone
              )}
            >
              {cloneElement(segment.icon, { size: 18 })}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[15px] font-semibold leading-tight">{label}</span>
                {describe && workflow.description && (
                  <span
                    className={clsx(
                      'shrink-0 rounded px-1.5 py-px text-[11px] font-semibold leading-tight',
                      segment.tone
                    )}
                  >
                    {segment.label}
                  </span>
                )}
              </span>
              <span className="text-xs leading-tight text-gray-6 dark:text-dark-2">
                {(describe && workflow.description) || `${segment.label} workflow`}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-blue-6 dark:text-blue-4">
              Change
              <IconChevronDown size={14} stroke={2.5} />
            </span>
          </button>
        }
      >
        <Stack gap="sm">
          {segments.length > 1 && (
            <ChoiceGroup
              aria-label="Workflow category"
              value={tab}
              onChange={(next) => setTab(next as WorkflowCategory)}
              data={segments.map((s) => ({ value: s.category, label: s.label }))}
            />
          )}
          <WorkflowListContent
            categories={segments.find((s) => s.category === tab)?.categories ?? []}
            selectedValue={selected?.workflow.id}
            onSelect={(graphKey, ecosystemIds, optionId) => {
              onChange?.(graphKey, ecosystemIds, optionId);
              setOpened(false);
            }}
            isCompatible={isCompatible}
            isMember={isMember}
          />
        </Stack>
      </PopoverOrSheet>
    </div>
  );
}
