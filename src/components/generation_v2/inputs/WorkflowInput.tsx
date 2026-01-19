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
} from '@tabler/icons-react';
import clsx from 'clsx';
import { forwardRef, useMemo } from 'react';

import { dialogStore } from '~/components/Dialog/dialogStore';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  getAllWorkflowsGrouped,
  workflowOptionById,
} from '~/shared/data-graph/generation/config/workflows';

// =============================================================================
// Types
// =============================================================================

export interface WorkflowOption {
  id: string;
  label: string;
  description?: string;
  compatible: boolean;
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
}

function WorkflowMenuItem({
  workflow,
  isSelected,
  onSelect,
  isCompatible = true,
}: WorkflowMenuItemProps) {
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
}

function WorkflowListContent({
  categories,
  selectedValue,
  onSelect,
  isCompatible,
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
}

function WorkflowSelectModal({
  title,
  categories,
  selectedValue,
  onSelect,
  isCompatible,
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
  /** Additional class name */
  className?: string;
}

/**
 * Displays the currently selected workflow with its label and description.
 * Can be used independently from WorkflowInput.
 */
export function SelectedWorkflowDisplay({ workflowId, className }: SelectedWorkflowDisplayProps) {
  const workflow = workflowId ? workflowOptionById.get(workflowId) : undefined;

  if (!workflow) return null;

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

// =============================================================================
// Component
// =============================================================================

export function WorkflowInput({
  value,
  onChange,
  disabled,
  className,
  isCompatible,
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
            />
          </Popover.Dropdown>
        </Popover>
      )}
    </Group>
  );
}
