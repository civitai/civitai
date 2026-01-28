/**
 * GeneratedItemWorkflowMenu
 *
 * Workflow-driven context menu for generated images/videos.
 * Derives available actions from workflow configs based on output type,
 * shows compatibility indicators, and routes selections to the generation form.
 */

import React from 'react';
import { Menu, Text } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconArrowsShuffle,
  IconCheck,
  IconExternalLink,
  IconInfoHexagon,
  IconPlayerTrackNextFilled,
  IconTrash,
  IconAlertTriangle,
} from '@tabler/icons-react';

import { useUpdateImageStepMetadata } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { generationStore } from '~/store/generation.store';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import type {
  NormalizedGeneratedImage,
  NormalizedGeneratedImageStep,
} from '~/server/services/orchestrator';
import {
  useGeneratedItemWorkflows,
  applyWorkflowWithCheck,
} from './hooks/useGeneratedItemWorkflows';

// =============================================================================
// Types
// =============================================================================

interface GeneratedItemWorkflowMenuProps {
  image: NormalizedGeneratedImage;
  step: Omit<NormalizedGeneratedImageStep, 'images'>;
  workflowId: string;
  workflowsOnly?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function GeneratedItemWorkflowMenu({
  image,
  step,
  workflowId,
  workflowsOnly,
}: GeneratedItemWorkflowMenuProps) {
  const { updateImages } = useUpdateImageStepMetadata();
  const { copied, copy } = useClipboard();

  const outputType = image.type === 'video' ? 'video' : 'image';
  const ecosystemKey =
    'baseModel' in step.params ? (step.params.baseModel as string | undefined) : undefined;

  const { groups, isCompatible } = useGeneratedItemWorkflows({
    outputType,
    ecosystemKey,
  });

  const canRemix = !!(step.params.workflow ?? (step.params as Record<string, unknown>).engine);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleRemix(seed?: number | null) {
    dialogStore.closeById('generated-image');
    generationStore.setData({
      resources: step.resources as any,
      params: { ...(step.params as any), seed: seed ?? null },
      remixOfId: step.metadata?.remixOfId,
      type: image.type,
      workflow: step.params.workflow,
      engine: (step.params as any).engine,
    });
  }

  function handleDeleteImage() {
    openConfirmModal({
      title: 'Delete image',
      children:
        'Are you sure that you want to delete this image? This is a destructive action and cannot be undone.',
      labels: { cancel: 'Cancel', confirm: 'Yes, delete it' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        updateImages([
          {
            workflowId,
            stepName: step.name,
            images: {
              [image.id]: { hidden: true },
            },
          },
        ]);
        dialogStore.closeById('generated-image');
      },
      zIndex: imageGenerationDrawerZIndex + 2,
      centered: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const hasWorkflows = groups.some((g) => g.workflows.length > 0);

  return (
    <>
      {/* Remix actions */}
      {canRemix && !workflowsOnly && (
        <>
          <Menu.Item
            onClick={() => handleRemix()}
            leftSection={<IconArrowsShuffle size={14} stroke={1.5} />}
          >
            Remix
          </Menu.Item>
          {image.seed && (
            <Menu.Item
              onClick={() => handleRemix(image.seed)}
              leftSection={<IconPlayerTrackNextFilled size={14} stroke={1.5} />}
            >
              Remix (with seed)
            </Menu.Item>
          )}
        </>
      )}

      {/* Delete */}
      {!workflowsOnly && (
        <Menu.Item
          color="red"
          onClick={handleDeleteImage}
          leftSection={<IconTrash size={14} stroke={1.5} />}
        >
          Delete
        </Menu.Item>
      )}

      {/* Workflow groups */}
      {hasWorkflows && !workflowsOnly && <Menu.Divider />}
      {groups.map((group) => (
        <React.Fragment key={group.category}>
          {workflowsOnly && group !== groups[0] && <Menu.Divider />}
          <Menu.Label>{group.label}</Menu.Label>
          {group.workflows.map((workflow) => (
            <Menu.Item
              key={workflow.id}
              onClick={() =>
                applyWorkflowWithCheck({
                  workflowId: workflow.id,
                  ecosystemKey,
                  image,
                  step,
                  compatible: workflow.compatible,
                })
              }
              className={!workflow.compatible ? 'opacity-60' : undefined}
              rightSection={
                !workflow.compatible ? (
                  <IconAlertTriangle size={14} className="text-yellow-5" />
                ) : undefined
              }
            >
              <Text size="sm">{workflow.label}</Text>
            </Menu.Item>
          ))}
        </React.Fragment>
      ))}

      {/* System actions */}
      {!workflowsOnly && (
        <>
          <Menu.Divider />
          <Menu.Label>System</Menu.Label>
          <Menu.Item
            leftSection={
              copied ? (
                <IconCheck size={14} stroke={1.5} />
              ) : (
                <IconInfoHexagon size={14} stroke={1.5} />
              )
            }
            onClick={() => copy(workflowId)}
          >
            Copy Workflow ID
          </Menu.Item>
          <Menu.Item
            leftSection={<IconExternalLink size={14} stroke={1.5} />}
            onClick={() => window.open(image.url, '_blank')}
          >
            Open in New Tab
          </Menu.Item>
        </>
      )}
    </>
  );
}
