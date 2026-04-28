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
  IconArrowLeft,
  IconCheck,
  IconMusic,
  IconPhoto,
  IconVideo,
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
  workflowConfigByKey,
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
  /** Called with (graphKey, ecosystemIds, optionId) when user selects a workflow */
  onChange?: (graphKey: string, ecosystemIds: number[], optionId: string) => void;
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
          <Text size="sm" fw={isSelected ? 600 : 400}>
            {workflow.label}
          </Text>
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

// =============================================================================
// Workflow Segment Button (icon-only segment within the segmented control)
// =============================================================================

interface WorkflowSegmentButtonProps {
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  hasDivider: boolean;
  disabled?: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

const WorkflowSegmentButton = forwardRef<HTMLButtonElement, WorkflowSegmentButtonProps>(
  ({ icon, label, isActive, hasDivider, disabled, onClick, onMouseEnter, onMouseLeave }, ref) => {
    return (
      <UnstyledButton
        ref={ref}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        disabled={disabled}
        title={label}
        aria-label={label}
        className={clsx(
          'flex h-full items-center justify-center px-3.5 transition-colors',
          hasDivider && 'border-l border-gray-3 dark:border-dark-4',
          isActive
            ? 'bg-blue-0 text-blue-7 dark:bg-blue-9/20 dark:text-blue-4'
            : 'text-gray-6 hover:bg-gray-1 hover:text-gray-9 dark:text-dark-2 dark:hover:bg-dark-5 dark:hover:text-gray-2',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      >
        {icon}
      </UnstyledButton>
    );
  }
);

WorkflowSegmentButton.displayName = 'WorkflowSegmentButton';

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
            onSelect(opt?.graphKey ?? workflow.id, opt?.ecosystemIds ?? [], workflow.id);
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
  onSelect: (graphKey: string, ecosystemIds: number[], optionId: string) => void;
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

  const handleSelect = (graphKey: string, ecosystemIds: number[], optionId: string) => {
    onSelect(graphKey, ecosystemIds, optionId);
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
  /** When provided, renders a back arrow button (used for enhancement workflows) */
  onBack?: () => void;
}

/**
 * Displays the currently selected workflow label and description.
 * Resolves variants to their parent workflow so e.g. "img2vid:first-last"
 * displays as "Image to Video".
 */
export function SelectedWorkflowDisplay({
  workflowId,
  ecosystemId,
  className,
  onBack,
}: SelectedWorkflowDisplayProps) {
  const resolvedId = workflowId
    ? workflowConfigByKey.get(workflowId)?.variantOf ?? workflowId
    : undefined;
  const workflow = resolvedId ? workflowOptionById.get(resolvedId) : undefined;
  if (!workflow) return null;

  const label = getWorkflowLabelForEcosystem(resolvedId!, ecosystemId);

  return (
    <div
      className={clsx(
        'rounded-lg border border-gray-2 bg-gray-0 px-3 py-2.5 dark:border-dark-4 dark:bg-dark-6',
        className
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          {onBack && (
            <UnstyledButton
              onClick={onBack}
              className="flex shrink-0 items-center rounded p-0.5 text-gray-6 hover:text-gray-9 dark:text-dark-2 dark:hover:text-dark-0"
              aria-label="Back to previous workflow"
            >
              <IconArrowLeft size={18} />
            </UnstyledButton>
          )}
          <Text size="md" fw={600} className="leading-tight">
            {label}
          </Text>
        </div>
        {workflow.description && (
          <Text size="sm" c="dimmed" className="mt-0.5">
            {workflow.description}
          </Text>
        )}
      </div>
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
  const [audioOpened, { close: closeAudio, open: openAudio }] = useDisclosure(false);

  // Get all workflows grouped by category (static - no ecosystem filtering)
  const options = useMemo(() => getAllWorkflowsGrouped(), []);
  const selected = getSelectedWorkflow(options, value, ecosystemId);

  // Separate image, video, and audio categories
  const imageCategories = options.filter((cat) => cat.category === 'image');
  const videoCategories = options.filter((cat) => cat.category === 'video');
  const audioCategories = options.filter((cat) => cat.category === 'audio');

  // Check if current selection is image, video, or audio
  const isImageWorkflow = selected && selected.category.category === 'image';
  const isVideoWorkflow = selected && selected.category.category === 'video';
  const isAudioWorkflow = selected && selected.category.category === 'audio';

  const handleImageSelect = (graphKey: string, ecosystemIds: number[], optionId: string) => {
    onChange?.(graphKey, ecosystemIds, optionId);
    closeImage();
  };

  const handleVideoSelect = (graphKey: string, ecosystemIds: number[], optionId: string) => {
    onChange?.(graphKey, ecosystemIds, optionId);
    closeVideo();
  };

  const handleAudioSelect = (graphKey: string, ecosystemIds: number[], optionId: string) => {
    onChange?.(graphKey, ecosystemIds, optionId);
    closeAudio();
  };

  const openImageModal = () => {
    dialogStore.trigger({
      id: 'workflow-select-image',
      component: WorkflowSelectModal,
      props: {
        title: 'Select Image Workflow',
        categories: imageCategories,
        selectedValue: selected?.workflow.id,
        onSelect: (graphKey: string, ecosystemIds: number[], optionId: string) =>
          onChange?.(graphKey, ecosystemIds, optionId),
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
        onSelect: (graphKey: string, ecosystemIds: number[], optionId: string) =>
          onChange?.(graphKey, ecosystemIds, optionId),
        isCompatible,
        isMember,
      },
    });
  };

  const openAudioModal = () => {
    dialogStore.trigger({
      id: 'workflow-select-audio',
      component: WorkflowSelectModal,
      props: {
        title: 'Select Audio Workflow',
        categories: audioCategories,
        selectedValue: selected?.workflow.id,
        onSelect: (graphKey: string, ecosystemIds: number[], optionId: string) =>
          onChange?.(graphKey, ecosystemIds, optionId),
        isCompatible,
        isMember,
      },
    });
  };

  // Check if video/audio workflows are available
  const hasVideoWorkflows = videoCategories.some((cat) => cat.workflows.length > 0);
  const hasAudioWorkflows = audioCategories.some((cat) => cat.workflows.length > 0);

  const segmentedContainerClass = clsx(
    'flex h-8 shrink-0 items-center overflow-hidden rounded-md border bg-white dark:bg-dark-6',
    'border-gray-3 dark:border-dark-4',
    className
  );

  // Mobile: use dialogStore modal — same segmented layout, click-to-open
  if (isMobile) {
    return (
      <div className={segmentedContainerClass}>
        <WorkflowSegmentButton
          icon={<IconPhoto size={16} />}
          label="Image"
          isActive={isImageWorkflow ?? false}
          hasDivider={false}
          disabled={disabled}
          onClick={openImageModal}
        />
        {hasVideoWorkflows && (
          <WorkflowSegmentButton
            icon={<IconVideo size={16} />}
            label="Video"
            isActive={isVideoWorkflow ?? false}
            hasDivider
            disabled={disabled}
            onClick={openVideoModal}
          />
        )}
        {hasAudioWorkflows && (
          <WorkflowSegmentButton
            icon={<IconMusic size={16} />}
            label="Audio"
            isActive={isAudioWorkflow ?? false}
            hasDivider
            disabled={disabled}
            onClick={openAudioModal}
          />
        )}
      </div>
    );
  }

  // Desktop: use Popover with hover
  const handleImageMouseEnter = () => {
    if (!disabled) {
      closeVideo();
      closeAudio();
      openImage();
    }
  };

  const handleVideoMouseEnter = () => {
    if (!disabled) {
      closeImage();
      closeAudio();
      openVideo();
    }
  };

  const handleAudioMouseEnter = () => {
    if (!disabled) {
      closeImage();
      closeVideo();
      openAudio();
    }
  };

  const hasSecondSegment = hasVideoWorkflows;
  const hasThirdSegment = hasAudioWorkflows;

  return (
    <div className={segmentedContainerClass}>
      <Popover
        opened={imageOpened}
        onChange={(isOpen) => !isOpen && closeImage()}
        position="bottom-start"
        width={300}
        shadow="md"
        withinPortal
      >
        <Popover.Target>
          <WorkflowSegmentButton
            icon={<IconPhoto size={16} />}
            label="Image"
            isActive={isImageWorkflow ?? false}
            hasDivider={false}
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

      {hasSecondSegment && (
        <Popover
          opened={videoOpened}
          onChange={(isOpen) => !isOpen && closeVideo()}
          position="bottom-start"
          width={300}
          shadow="md"
          withinPortal
        >
          <Popover.Target>
            <WorkflowSegmentButton
              icon={<IconVideo size={16} />}
              label="Video"
              isActive={isVideoWorkflow ?? false}
              hasDivider
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

      {hasThirdSegment && (
        <Popover
          opened={audioOpened}
          onChange={(isOpen) => !isOpen && closeAudio()}
          position="bottom-start"
          width={300}
          shadow="md"
          withinPortal
        >
          <Popover.Target>
            <WorkflowSegmentButton
              icon={<IconMusic size={16} />}
              label="Audio"
              isActive={isAudioWorkflow ?? false}
              hasDivider
              disabled={disabled}
              onClick={() => undefined}
              onMouseEnter={handleAudioMouseEnter}
              onMouseLeave={closeAudio}
            />
          </Popover.Target>
          <Popover.Dropdown
            p="xs"
            onMouseEnter={openAudio}
            onMouseLeave={closeAudio}
            className="before:absolute before:-top-2 before:left-0 before:h-2 before:w-full"
          >
            <WorkflowListContent
              categories={audioCategories}
              selectedValue={selected?.workflow.id}
              onSelect={handleAudioSelect}
              isCompatible={isCompatible}
              isMember={isMember}
            />
          </Popover.Dropdown>
        </Popover>
      )}
    </div>
  );
}
