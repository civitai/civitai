import { Badge, Modal, Text, Tooltip, UnstyledButton } from '@mantine/core';
import {
  IconAlignLeft,
  IconArrowLeft,
  IconChevronDown,
  IconCube,
  IconDiamond,
  IconLayoutGrid,
  IconMusic,
  IconPhoto,
  IconVideo,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useMemo, useState } from 'react';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ExperimentalFlask } from '~/components/generation_v2/Experimental';
import {
  useAvailableWorkflowGroups,
  useWorkflowGateStates,
} from '~/components/generation_v2/inputs/workflow-visibility';
import { RequireMembership } from '~/components/RequireMembership/RequireMembership';
import { SupportButtonPolymorphic } from '~/components/SupportButton/SupportButton';
import {
  getWorkflowLabelForEcosystem,
  workflowConfigByKey,
  type WorkflowOption,
} from '~/shared/data-graph/generation/config/workflows';
import type { WorkflowCategory } from '~/shared/data-graph/generation/config/types';
import type { GateItemState } from '~/shared/data-graph/generation/gates';

/**
 * The form-graph lane's workflow control: one chip, one modal, every workflow
 * listed once with its input type as an attribute.
 *
 * Replaces generation_v2's four-segment `WorkflowInput` (one popover per output
 * category) and the `getWorkflowModes` button strip beneath it. The strip set
 * the same workflow key this picker sets, differing only on the input axis —
 * which is the filter across the top here.
 */

const INPUT_TYPES = [
  { id: 'text', label: 'From text', Icon: IconAlignLeft },
  { id: 'image', label: 'From image', Icon: IconPhoto },
  { id: 'video', label: 'From video', Icon: IconVideo },
] as const;

type InputTypeId = (typeof INPUT_TYPES)[number]['id'];
type FilterId = InputTypeId | 'all';

const inputTypeById = new Map<string, (typeof INPUT_TYPES)[number]>(
  INPUT_TYPES.map((i) => [i.id, i])
);

const CATEGORY_ICONS: Record<WorkflowCategory, typeof IconPhoto> = {
  image: IconPhoto,
  video: IconVideo,
  audio: IconMusic,
  model3d: IconCube,
};

type WorkflowEntry = { option: WorkflowOption; gate?: GateItemState };
type WorkflowGroupEntry = { category: WorkflowCategory; label: string; workflows: WorkflowEntry[] };

/**
 * Visible workflows, grouped by output category. Applies the same three filters
 * the v2 picker did — ecosystems hidden by a gate rule, feature flags, then
 * workflow-level gate rules — so a key hidden for this user never renders.
 */
function useWorkflowGroups(): WorkflowGroupEntry[] {
  const grouped = useAvailableWorkflowGroups();
  const { hiddenSet, stateMap } = useWorkflowGateStates();

  return useMemo(
    () =>
      grouped.map((group) => ({
        category: group.category,
        label: group.label,
        workflows: group.workflows
          .filter((option) => !hiddenSet.has(option.graphKey))
          .map((option) => ({ option, gate: stateMap.get(option.graphKey) })),
      })),
    [grouped, hiddenSet, stateMap]
  );
}

/**
 * The option to highlight. An alias shares its parent's graphKey, so prefer an
 * exact id match, then the alias carrying the current ecosystem, then any match.
 */
function findSelected(groups: WorkflowGroupEntry[], value?: string, ecosystemId?: number) {
  if (!value) return undefined;
  const graphKey = workflowConfigByKey.get(value)?.variantOf ?? value;
  let fallback: WorkflowEntry | undefined;

  for (const group of groups) {
    for (const entry of group.workflows) {
      if (entry.option.id === value) return entry;
      if (entry.option.graphKey !== graphKey) continue;
      if (ecosystemId !== undefined && entry.option.ecosystemIds.includes(ecosystemId))
        return entry;
      fallback ??= entry;
    }
  }
  return fallback;
}

/** A workflow whose ecosystems exclude the current one will move the form off it. */
function switchesEcosystem(option: WorkflowOption, ecosystemId?: number) {
  if (option.ecosystemIds.length === 0 || ecosystemId === undefined) return false;
  return !option.ecosystemIds.includes(ecosystemId);
}

// =============================================================================
// Row
// =============================================================================

function WorkflowRow({
  entry,
  isSelected,
  ecosystemId,
  isMember,
  onSelect,
}: {
  entry: WorkflowEntry;
  isSelected: boolean;
  ecosystemId?: number;
  isMember: boolean;
  onSelect: () => void;
}) {
  const { option, gate } = entry;
  const input = inputTypeById.get(option.inputType);
  const InputIcon = input?.Icon ?? IconAlignLeft;

  const body = (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Text size="sm" fw={600} className="leading-tight">
          {option.label}
        </Text>
        <ExperimentalFlask target={{ kind: 'workflow', key: option.graphKey }} size={16} />
        {option.isNew && (
          <Badge size="xs" color="green" variant="filled" radius="sm">
            New
          </Badge>
        )}
        {switchesEcosystem(option, ecosystemId) && (
          <Badge size="xs" color="orange" variant="light" radius="sm">
            Switches model
          </Badge>
        )}
      </div>
      {option.description && (
        <Text size="xs" c="dimmed" className="mt-0.5 leading-snug">
          {option.description}
        </Text>
      )}
      <div className="mt-1.5 flex items-center gap-1 text-xs text-gray-6 dark:text-dark-2">
        <InputIcon size={12} />
        {input?.label}
      </div>
    </div>
  );

  if (gate?.state === 'disabled') {
    return (
      <Tooltip
        label={gate.message ?? 'This workflow is currently unavailable'}
        position="top"
        withArrow
        openDelay={300}
      >
        <div className="flex w-full cursor-not-allowed gap-3 rounded-lg border border-gray-2 p-3 opacity-50 dark:border-dark-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-gray-2 dark:bg-dark-5">
            <InputIcon size={15} />
          </div>
          {body}
          <Badge size="xs" color="gray" variant="light">
            Disabled
          </Badge>
        </div>
      </Tooltip>
    );
  }

  if (gate?.state === 'memberOnly' || (option.memberOnly && !isMember)) {
    return (
      <RequireMembership>
        <SupportButtonPolymorphic className="!h-auto w-full !p-3 text-left">
          <div className="flex w-full gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-gray-2 dark:bg-dark-5">
              <IconDiamond size={15} />
            </div>
            {body}
          </div>
        </SupportButtonPolymorphic>
      </RequireMembership>
    );
  }

  return (
    <UnstyledButton
      onClick={onSelect}
      aria-pressed={isSelected}
      className={clsx(
        'flex w-full gap-3 rounded-lg border p-3 text-left transition-colors',
        isSelected
          ? 'border-blue-5 bg-blue-0 dark:border-blue-8 dark:bg-blue-9/20'
          : 'border-gray-2 hover:border-gray-4 dark:border-dark-4 dark:hover:border-dark-3'
      )}
    >
      <div
        className={clsx(
          'flex size-8 shrink-0 items-center justify-center rounded-md',
          isSelected ? 'bg-blue-6 text-white' : 'bg-gray-2 dark:bg-dark-5'
        )}
      >
        <InputIcon size={15} />
      </div>
      {body}
    </UnstyledButton>
  );
}

// =============================================================================
// Modal
// =============================================================================

type WorkflowPickerModalProps = {
  value?: string;
  ecosystemId?: number;
  isMember: boolean;
  onChange: (graphKey: string, ecosystemIds: number[], optionId: string) => void;
};

export function WorkflowPickerModal({
  value,
  ecosystemId,
  isMember,
  onChange,
}: WorkflowPickerModalProps) {
  const dialog = useDialogContext();
  const groups = useWorkflowGroups();
  const [filter, setFilter] = useState<FilterId>('all');
  const selected = findSelected(groups, value, ecosystemId);

  const counts = useMemo(() => {
    const byInput = new Map<InputTypeId, number>();
    let all = 0;
    for (const group of groups)
      for (const { option } of group.workflows) {
        all++;
        const key = option.inputType;
        byInput.set(key, (byInput.get(key) ?? 0) + 1);
      }
    return { all, byInput };
  }, [groups]);

  const filters: { id: FilterId; label: string; Icon: typeof IconPhoto; count: number }[] = [
    { id: 'all', label: 'All', Icon: IconLayoutGrid, count: counts.all },
    ...INPUT_TYPES.map((i) => ({
      id: i.id as FilterId,
      label: i.label,
      Icon: i.Icon,
      count: counts.byInput.get(i.id) ?? 0,
    })),
  ];

  function handleSelect(option: WorkflowOption) {
    onChange(option.graphKey, option.ecosystemIds, option.id);
    dialog.onClose();
  }

  return (
    <Modal
      {...dialog}
      title={
        <div>
          <Text fw={600}>What are you making?</Text>
          <Text size="xs" c="dimmed">
            Operation and input, in one list
          </Text>
        </div>
      }
      size="lg"
    >
      <div
        className="mb-3 flex flex-wrap gap-1.5"
        role="group"
        aria-label="Filter workflows by input"
      >
        {filters.map(({ id, label, Icon, count }) =>
          count === 0 ? null : (
            <UnstyledButton
              key={id}
              onClick={() => setFilter(id)}
              aria-pressed={filter === id}
              aria-label={label}
              className={clsx(
                'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold',
                filter === id
                  ? 'border-gray-5 bg-gray-1 dark:border-dark-3 dark:bg-dark-5'
                  : 'border-gray-2 text-gray-6 hover:border-gray-4 dark:border-dark-4 dark:text-dark-2'
              )}
            >
              <Icon size={13} />
              {label}
              <span className="opacity-60">{count}</span>
            </UnstyledButton>
          )
        )}
      </div>

      <div className="flex flex-col gap-4">
        {groups.map((group) => {
          const workflows = group.workflows.filter(
            ({ option }) => filter === 'all' || option.inputType === filter
          );
          if (!workflows.length) return null;
          const CategoryIcon = CATEGORY_ICONS[group.category];

          return (
            <div key={group.category}>
              <div className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-gray-6 dark:text-dark-2">
                <CategoryIcon size={12} />
                {group.label}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {workflows.map((entry) => (
                  <WorkflowRow
                    key={entry.option.id}
                    entry={entry}
                    isSelected={entry.option.id === selected?.option.id}
                    ecosystemId={ecosystemId}
                    isMember={isMember}
                    onSelect={() => handleSelect(entry.option)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// =============================================================================
// Chip
// =============================================================================

export type WorkflowPickerProps = {
  value?: string;
  ecosystemId?: number;
  onChange?: (graphKey: string, ecosystemIds: number[], optionId: string) => void;
  isMember?: boolean;
  disabled?: boolean;
  className?: string;
  /** Renders a back arrow beside the chip, for enhancement workflows. */
  onBack?: () => void;
};

export function WorkflowPicker({
  value,
  ecosystemId,
  onChange,
  isMember = false,
  disabled,
  className,
  onBack,
}: WorkflowPickerProps) {
  const groups = useWorkflowGroups();
  const selected = findSelected(groups, value, ecosystemId);
  const option = selected?.option;
  const input = option ? inputTypeById.get(option.inputType) : undefined;
  const CategoryIcon = option ? CATEGORY_ICONS[option.category] : IconLayoutGrid;
  const label = option
    ? getWorkflowLabelForEcosystem(option.graphKey, ecosystemId)
    : 'Select a workflow';

  function open() {
    if (disabled) return;
    dialogStore.trigger({
      id: 'workflow-picker',
      component: WorkflowPickerModal,
      props: {
        value,
        ecosystemId,
        isMember,
        onChange: (graphKey: string, ecosystemIds: number[], optionId: string) =>
          onChange?.(graphKey, ecosystemIds, optionId),
      },
    });
  }

  return (
    <div className={clsx('flex min-w-0 items-center gap-1', className)}>
      {onBack && (
        <UnstyledButton
          onClick={onBack}
          aria-label="Back to previous workflow"
          className="flex shrink-0 items-center rounded p-1 text-gray-6 hover:text-gray-9 dark:text-dark-2 dark:hover:text-dark-0"
        >
          <IconArrowLeft size={18} />
        </UnstyledButton>
      )}
      <UnstyledButton
        onClick={open}
        disabled={disabled}
        className={clsx(
          'flex min-w-0 items-center gap-1.5 rounded-full border border-blue-5 bg-blue-0 px-3 py-1.5',
          'text-sm font-semibold text-blue-7 dark:border-blue-8 dark:bg-blue-9/20 dark:text-blue-4',
          disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-blue-1 dark:hover:bg-blue-9/30'
        )}
      >
        <CategoryIcon size={14} className="shrink-0" />
        <span className="truncate">{label}</span>
        {input && <span className="shrink-0 font-normal opacity-70">· {input.label}</span>}
        <IconChevronDown size={12} className="shrink-0" />
      </UnstyledButton>
    </div>
  );
}
