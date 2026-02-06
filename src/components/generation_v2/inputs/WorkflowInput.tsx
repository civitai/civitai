/**
 * WorkflowInput
 *
 * A form input for selecting generation features (workflows).
 * Displays inline menu cards for Image and Video features, each opening their own dropdown.
 * Uses Popover on desktop and dialogStore modal on mobile.
 */

import { Badge, Button, Group, Modal, Popover, Text, UnstyledButton, Stack } from '@mantine/core';
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
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import {
  getAllWorkflowsGrouped,
  getWorkflowsForEcosystem,
  workflowOptionById,
  type WorkflowOption as ConfigWorkflowOption,
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
  value?: string;
  onChange?: (value: string) => void;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Additional class name for the container */
  className?: string;
  /** Check if a workflow is compatible with the current ecosystem */
  isCompatible?: (workflowId: string) => boolean;
  /** Whether the current user is a member */
  isMember?: boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

function getSelectedWorkflow(
  options: WorkflowCategoryGroup[],
  value?: string
): { workflow: WorkflowOption; category: WorkflowCategoryGroup } | undefined {
  for (const category of options) {
    const workflow = category.workflows.find((w) => w.id === value);
    if (workflow) return { workflow, category };
  }
  return undefined;
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
            className="w-full !px-3 !py-2.5 !h-auto !min-h-[44px]"
          >
            <div className="flex flex-col items-start gap-0.5 py-0.5">
              <span className="text-sm leading-tight">{workflow.label}</span>
              {workflow.description && (
                <span className="text-xs text-dimmed opacity-70 leading-tight">
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
  onSelect: (workflowId: string) => void;
  isCompatible?: (workflowId: string) => boolean;
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
          onSelect={() => onSelect(workflow.id)}
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
  onSelect: (workflowId: string) => void;
  isCompatible?: (workflowId: string) => boolean;
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

  const handleSelect = (workflowId: string) => {
    onSelect(workflowId);
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
  /** The workflow ID to display */
  workflowId?: string;
  /** The current ecosystem key (used to determine available workflows) */
  ecosystemKey?: string;
  /** Called when the user selects a different workflow */
  onChange?: (workflowId: string) => void;
  /** Additional class name */
  className?: string;
}

const INPUT_TYPE_LABELS: Record<string, string> = {
  text: 'From text',
  image: 'From image',
  video: 'From video',
};

/**
 * Displays the currently selected workflow with input type buttons and workflow badges.
 * - When multiple input types are available, shows buttons to switch between them.
 * - Always shows the selected workflow as a badge (with sibling badges when multiple exist).
 * - Falls back to a simple label when only one workflow total is available.
 */
export function SelectedWorkflowDisplay({
  workflowId,
  ecosystemKey,
  onChange,
  className,
}: SelectedWorkflowDisplayProps) {
  const workflow = workflowId ? workflowOptionById.get(workflowId) : undefined;

  // Get available workflows for the current ecosystem, excluding enhancements,
  // grouped by input type (text, image, video)
  const workflowsByInputType = useMemo(() => {
    if (!ecosystemKey) return new Map<string, ConfigWorkflowOption[]>();
    const ecosystem = ecosystemByKey.get(ecosystemKey);
    if (!ecosystem) return new Map<string, ConfigWorkflowOption[]>();

    const available = getWorkflowsForEcosystem(ecosystem.id).filter(
      (w) => !w.category.endsWith('enhancements')
    );

    const groups = new Map<string, ConfigWorkflowOption[]>();
    for (const w of available) {
      const existing = groups.get(w.inputType) ?? [];
      existing.push(w);
      groups.set(w.inputType, existing);
    }
    return groups;
  }, [ecosystemKey]);

  if (!workflow) return null;

  const currentInputType = workflow.inputType;
  const inputTypes = Array.from(workflowsByInputType.keys());
  const hasMultipleInputTypes = inputTypes.length > 1;
  const currentTypeWorkflows = workflowsByInputType.get(currentInputType) ?? [];

  // Nothing interesting to show — single workflow, single input type
  if (!hasMultipleInputTypes && currentTypeWorkflows.length <= 1) {
    return (
      <div
        className={clsx(
          'rounded-lg border border-gray-2 bg-gray-0 px-3 py-2.5 dark:border-dark-4 dark:bg-dark-6',
          className
        )}
      >
        <Text size="md" fw={600} className="leading-tight">
          {workflow.label}
        </Text>
        {workflow.description && (
          <Text size="sm" c="dimmed" className="mt-0.5">
            {workflow.description}
          </Text>
        )}
      </div>
    );
  }

  const handleInputTypeChange = (newInputType: string) => {
    const workflows = workflowsByInputType.get(newInputType);
    if (workflows?.length) {
      onChange?.(workflows[0].id);
    }
  };

  return (
    <div
      className={clsx(
        'rounded-lg border border-gray-2 bg-gray-0 px-3 py-2.5 dark:border-dark-4 dark:bg-dark-6',
        className
      )}
    >
      {hasMultipleInputTypes && (
        <Group gap={6} wrap="nowrap">
          {inputTypes.map((type) => (
            <Button
              key={type}
              size="compact-xs"
              variant={type === currentInputType ? 'filled' : 'default'}
              onClick={() => handleInputTypeChange(type)}
            >
              {INPUT_TYPE_LABELS[type] ?? type}
            </Button>
          ))}
        </Group>
      )}
      <Group gap={6} wrap="wrap" className={hasMultipleInputTypes ? 'mt-2' : ''}>
        {currentTypeWorkflows.map((w) => (
          <Badge
            key={w.id}
            variant={w.id === workflowId ? 'filled' : 'light'}
            color={w.id === workflowId ? 'blue' : 'gray'}
            className="cursor-pointer"
            onClick={() => onChange?.(w.id)}
          >
            {w.label}
          </Badge>
        ))}
      </Group>
      {workflow.description && (
        <Text size="sm" c="dimmed" className="mt-1.5">
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
  const selected = getSelectedWorkflow(options, value);

  // Separate image and video categories
  const imageCategories = options.filter(
    (cat) =>
      cat.category === 'text-to-image' ||
      cat.category === 'image-to-image' ||
      cat.category === 'image-enhancements'
  );
  const videoCategories = options.filter(
    (cat) =>
      cat.category === 'text-to-video' ||
      cat.category === 'image-to-video' ||
      cat.category === 'video-enhancements'
  );

  // Check if current selection is image or video
  const isImageWorkflow =
    selected &&
    (selected.category.category === 'text-to-image' ||
      selected.category.category === 'image-to-image' ||
      selected.category.category === 'image-enhancements');
  const isVideoWorkflow =
    selected &&
    (selected.category.category === 'text-to-video' ||
      selected.category.category === 'image-to-video' ||
      selected.category.category === 'video-enhancements');

  const handleImageSelect = (workflowId: string) => {
    onChange?.(workflowId);
    closeImage();
  };

  const handleVideoSelect = (workflowId: string) => {
    onChange?.(workflowId);
    closeVideo();
  };

  const openImageModal = () => {
    dialogStore.trigger({
      id: 'workflow-select-image',
      component: WorkflowSelectModal,
      props: {
        title: 'Select Image Workflow',
        categories: imageCategories,
        selectedValue: value,
        onSelect: (workflowId: string) => onChange?.(workflowId),
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
        selectedValue: value,
        onSelect: (workflowId: string) => onChange?.(workflowId),
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
            selectedValue={value}
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
              selectedValue={value}
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
