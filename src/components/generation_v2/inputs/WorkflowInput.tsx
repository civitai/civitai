/**
 * WorkflowInput
 *
 * A form input for selecting generation features (workflows).
 * Displays inline menu cards for Image and Video features, each opening their own dropdown.
 * Uses Popover on desktop and dialogStore modal on mobile.
 */

import { Group, Modal, Popover, Text, UnstyledButton, Stack } from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import {
  IconChevronDown,
  IconCheck,
  IconPhoto,
  IconVideo,
  IconArrowRight,
  IconDiamond,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { forwardRef, useMemo } from 'react';

import { dialogStore } from '~/components/Dialog/dialogStore';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { RequireMembership } from '~/components/RequireMembership/RequireMembership';
import { SupportButtonPolymorphic } from '~/components/SupportButton/SupportButton';
import {
  getAllWorkflowsGrouped,
  workflowOptionById,
  getWorkflowLabelForEcosystem,
} from '~/shared/data-graph/generation/config/workflows';

// =============================================================================
// Types
// =============================================================================

export interface WorkflowOption {
  id: string;
  label: string;
  description?: string;
  compatible: boolean;
  memberOnly?: boolean;
}

export interface WorkflowCategoryGroup {
  category: string;
  label: string;
  workflows: WorkflowOption[];
}

export interface WorkflowInputProps {
  /** Graph workflow key (e.g., 'img2vid') */
  value?: string;
  /** Called with (graphKey, ecosystemIds) when user selects a workflow */
  onChange?: (graphKey: string, ecosystemIds: number[]) => void;
  /** Current ecosystem ID — used to highlight the correct alias entry */
  ecosystemId?: number;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Additional class name for the container */
  className?: string;
  /** Check if a workflow option is compatible with the current ecosystem */
  isCompatible?: (optionId: string) => boolean;
  /** Whether the current user is a member */
  isMember?: boolean;
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
}

function WorkflowMenuItem({
  workflow,
  isSelected,
  onSelect,
  isCompatible = true,
  isMember = false,
}: WorkflowMenuItemProps) {
  const disabled = workflow.memberOnly && !isMember;

  if (disabled) {
    return (
      <RequireMembership>
        <SupportButtonPolymorphic
          icon={IconDiamond}
          position="right"
          className="!h-auto !min-h-[44px] w-full !px-3 !py-2.5"
        >
          <div className="flex flex-col items-start gap-0.5 py-0.5">
            <span className="text-sm leading-tight">{workflow.label}</span>
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
        isSelected ? 'bg-blue-0 dark:bg-blue-9/20' : 'hover:bg-gray-1 dark:hover:bg-dark-5'
      )}
    >
      <Group gap="sm" wrap="nowrap" justify="space-between">
        <div className="min-w-0 flex-1">
          <Text size="sm" fw={isSelected ? 600 : 400} c={!isCompatible ? 'dimmed' : undefined}>
            {workflow.label}
          </Text>
          {workflow.description && (
            <Text size="xs" c="dimmed" className="mt-0.5">
              {workflow.description}
            </Text>
          )}
        </div>
        {isSelected && <IconCheck size={16} className="shrink-0 text-blue-6" />}
        {!isCompatible && !isSelected && (
          <IconArrowRight size={14} className="shrink-0 text-gray-4 dark:text-dark-3" />
        )}
      </Group>
    </UnstyledButton>
  );
}

// =============================================================================
// Workflow Type Button (Image/Video toggle)
// =============================================================================

interface WorkflowTypeButtonProps {
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  opened: boolean;
  disabled?: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

const WorkflowTypeButton = forwardRef<HTMLButtonElement, WorkflowTypeButtonProps>(
  ({ icon, label, isActive, opened, disabled, onClick, onMouseEnter, onMouseLeave }, ref) => {
    return (
      <UnstyledButton
        ref={ref}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        disabled={disabled}
        className={clsx(
          'flex items-center gap-1.5 rounded-md border px-3 py-1.5 transition-colors',
          isActive
            ? 'border-blue-5 bg-blue-0 text-blue-7 dark:border-blue-6 dark:bg-blue-9/20 dark:text-blue-4'
            : 'border-gray-3 bg-white text-gray-7 hover:border-blue-3 dark:border-dark-4 dark:bg-dark-6 dark:text-gray-3 dark:hover:border-dark-3',
          disabled && 'cursor-not-allowed opacity-50',
          opened && 'ring-2 ring-blue-5/20'
        )}
      >
        {icon}
        <Text size="sm" fw={isActive ? 600 : 500}>
          {label}
        </Text>
        <IconChevronDown
          size={14}
          className={clsx('text-gray-5 transition-transform', opened && 'rotate-180')}
        />
      </UnstyledButton>
    );
  }
);

WorkflowTypeButton.displayName = 'WorkflowTypeButton';

// =============================================================================
// Workflow List Content (shared between Popover and Modal)
// =============================================================================

interface WorkflowListContentProps {
  categories: WorkflowCategoryGroup[];
  selectedValue?: string;
  onSelect: (graphKey: string, ecosystemIds: number[]) => void;
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
  // Flatten all workflows with compatibility info
  const allWorkflows = useMemo(() => {
    const workflows: Array<{ workflow: WorkflowOption; compatible: boolean }> = [];

    for (const category of categories) {
      for (const workflow of category.workflows) {
        const compatible = isCompatible?.(workflow.id) ?? true;
        workflows.push({ workflow, compatible });
      }
    }

    return workflows;
  }, [categories, isCompatible]);

  return (
    <Stack gap={2}>
      {allWorkflows.map(({ workflow, compatible }) => (
        <WorkflowMenuItem
          key={workflow.id}
          workflow={workflow}
          isSelected={workflow.id === selectedValue}
          onSelect={() => {
            const opt = workflowOptionById.get(workflow.id);
            onSelect(opt?.graphKey ?? workflow.id, opt?.ecosystemIds ?? []);
          }}
          isCompatible={compatible}
          isMember={isMember}
        />
      ))}
    </Stack>
  );
}

// =============================================================================
// Mobile Modal Component (for dialogStore)
// =============================================================================

interface WorkflowSelectModalProps {
  title: string;
  categories: WorkflowCategoryGroup[];
  selectedValue?: string;
  onSelect: (graphKey: string, ecosystemIds: number[]) => void;
  isCompatible?: (optionId: string) => boolean;
  isMember?: boolean;
}

function WorkflowSelectModal({
  title,
  categories,
  selectedValue,
  onSelect,
  isCompatible,
  isMember = false,
}: WorkflowSelectModalProps) {
  const dialog = useDialogContext();

  const handleSelect = (graphKey: string, ecosystemIds: number[]) => {
    onSelect(graphKey, ecosystemIds);
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      onClose={dialog.onClose}
      title={title}
      fullScreen
      styles={{
        header: {
          borderBottom: '1px solid var(--mantine-color-default-border)',
        },
      }}
    >
      <Stack gap="xs" pt="md">
        <WorkflowListContent
          categories={categories}
          selectedValue={selectedValue}
          onSelect={handleSelect}
          isCompatible={isCompatible}
          isMember={isMember}
        />
      </Stack>
    </Modal>
  );
}

// =============================================================================
// Selected Workflow Display (standalone component)
// =============================================================================

export interface SelectedWorkflowDisplayProps {
  /** The workflow graph key to display */
  workflowId?: string;
  /** Current ecosystem ID — used to show alias-aware label */
  ecosystemId?: number;
  /** Additional class name */
  className?: string;
}

/**
 * Displays the currently selected workflow label and description.
 * Uses ecosystem-aware label so Vidu shows "First/Last Frame" instead of "Image to Video".
 */
export function SelectedWorkflowDisplay({
  workflowId,
  ecosystemId,
  className,
}: SelectedWorkflowDisplayProps) {
  const workflow = workflowId ? workflowOptionById.get(workflowId) : undefined;
  if (!workflow) return null;

  const label = getWorkflowLabelForEcosystem(workflowId!, ecosystemId);

  return (
    <div
      className={clsx(
        'rounded-lg border border-gray-2 bg-gray-0 px-3 py-2.5 dark:border-dark-4 dark:bg-dark-6',
        className
      )}
    >
      <Text size="md" fw={600} className="leading-tight">
        {label}
      </Text>
      {workflow.description && (
        <Text size="sm" c="dimmed" className="mt-0.5">
          {workflow.description}
        </Text>
      )}
    </div>
  );
}

// =============================================================================
// Component
// =============================================================================

export function WorkflowInput({
  value,
  onChange,
  ecosystemId,
  disabled,
  className,
  isCompatible,
  isMember = false,
}: WorkflowInputProps) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [imageOpened, { close: closeImage, open: openImage }] = useDisclosure(false);
  const [videoOpened, { close: closeVideo, open: openVideo }] = useDisclosure(false);

  // Get all workflows grouped by category (static - no ecosystem filtering)
  const options = useMemo(() => getAllWorkflowsGrouped(), []);
  const selected = getSelectedWorkflow(options, value, ecosystemId);

  // Separate image and video categories
  const imageCategories = options.filter((cat) => cat.category === 'image');
  const videoCategories = options.filter((cat) => cat.category === 'video');

  // Check if current selection is image or video
  const isImageWorkflow = selected && selected.category.category === 'image';
  const isVideoWorkflow = selected && selected.category.category === 'video';

  const handleImageSelect = (graphKey: string, ecosystemIds: number[]) => {
    onChange?.(graphKey, ecosystemIds);
    closeImage();
  };

  const handleVideoSelect = (graphKey: string, ecosystemIds: number[]) => {
    onChange?.(graphKey, ecosystemIds);
    closeVideo();
  };

  const openImageModal = () => {
    dialogStore.trigger({
      id: 'workflow-select-image',
      component: WorkflowSelectModal,
      props: {
        title: 'Select Image Workflow',
        categories: imageCategories,
        selectedValue: selected?.workflow.id,
        onSelect: (graphKey: string, ecosystemIds: number[]) => onChange?.(graphKey, ecosystemIds),
        isCompatible,
        isMember,
      },
    });
  };

  const openVideoModal = () => {
    dialogStore.trigger({
      id: 'workflow-select-video',
      component: WorkflowSelectModal,
      props: {
        title: 'Select Video Workflow',
        categories: videoCategories,
        selectedValue: selected?.workflow.id,
        onSelect: (graphKey: string, ecosystemIds: number[]) => onChange?.(graphKey, ecosystemIds),
        isCompatible,
        isMember,
      },
    });
  };

  // Check if video workflows are available
  const hasVideoWorkflows = videoCategories.some((cat) => cat.workflows.length > 0);

  // Mobile: use dialogStore modal
  if (isMobile) {
    return (
      <Group gap="xs" className={className} wrap="nowrap">
        <WorkflowTypeButton
          icon={null}
          label="Image"
          isActive={isImageWorkflow ?? false}
          opened={false}
          disabled={disabled}
          onClick={openImageModal}
        />
        {hasVideoWorkflows && (
          <WorkflowTypeButton
            icon={null}
            label="Video"
            isActive={isVideoWorkflow ?? false}
            opened={false}
            disabled={disabled}
            onClick={openVideoModal}
          />
        )}
      </Group>
    );
  }

  // Desktop: use Popover with hover
  const handleImageMouseEnter = () => {
    if (!disabled) {
      closeVideo();
      openImage();
    }
  };

  const handleVideoMouseEnter = () => {
    if (!disabled) {
      closeImage();
      openVideo();
    }
  };

  return (
    <Group gap="xs" className={className} wrap="nowrap">
      <Popover
        opened={imageOpened}
        onChange={(isOpen) => !isOpen && closeImage()}
        position="bottom-start"
        width={300}
        shadow="md"
        withinPortal
      >
        <Popover.Target>
          <WorkflowTypeButton
            icon={<IconPhoto size={16} />}
            label="Image"
            isActive={isImageWorkflow ?? false}
            opened={imageOpened}
            disabled={disabled}
            onClick={() => undefined}
            onMouseEnter={handleImageMouseEnter}
            onMouseLeave={closeImage}
          />
        </Popover.Target>
        <Popover.Dropdown
          p="xs"
          onMouseEnter={openImage}
          onMouseLeave={closeImage}
          className="before:absolute before:-top-2 before:left-0 before:h-2 before:w-full"
        >
          <WorkflowListContent
            categories={imageCategories}
            selectedValue={selected?.workflow.id}
            onSelect={handleImageSelect}
            isCompatible={isCompatible}
            isMember={isMember}
          />
        </Popover.Dropdown>
      </Popover>

      {hasVideoWorkflows && (
        <Popover
          opened={videoOpened}
          onChange={(isOpen) => !isOpen && closeVideo()}
          position="bottom-start"
          width={300}
          shadow="md"
          withinPortal
        >
          <Popover.Target>
            <WorkflowTypeButton
              icon={<IconVideo size={16} />}
              label="Video"
              isActive={isVideoWorkflow ?? false}
              opened={videoOpened}
              disabled={disabled}
              onClick={() => undefined}
              onMouseEnter={handleVideoMouseEnter}
              onMouseLeave={closeVideo}
            />
          </Popover.Target>
          <Popover.Dropdown
            p="xs"
            onMouseEnter={openVideo}
            onMouseLeave={closeVideo}
            className="before:absolute before:-top-2 before:left-0 before:h-2 before:w-full"
          >
            <WorkflowListContent
              categories={videoCategories}
              selectedValue={selected?.workflow.id}
              onSelect={handleVideoSelect}
              isCompatible={isCompatible}
              isMember={isMember}
            />
          </Popover.Dropdown>
        </Popover>
      )}
    </Group>
  );
}
