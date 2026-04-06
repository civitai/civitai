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
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import {
  IconArrowsShuffle,
  IconCheck,
  IconExternalLink,
  IconInfoHexagon,
  IconPlayerTrackNextFilled,
  IconTrash,
  IconDiamond,
} from '@tabler/icons-react';

import { useUpdateImageStepMetadata } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { generationGraphStore } from '~/store/generation-graph.store';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import { RequireMembership } from '~/components/RequireMembership/RequireMembership';
import { SupportButtonPolymorphic } from '~/components/SupportButton/SupportButton';
import type { BlobData } from '~/shared/orchestrator/workflow-data';
import {
  useGeneratedItemWorkflows,
  applyWorkflowWithCheck,
} from './hooks/useGeneratedItemWorkflows';

// =============================================================================
// Types
// =============================================================================

interface GeneratedItemWorkflowMenuProps {
  image: BlobData;
  workflowsOnly?: boolean;
  isLightbox?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function GeneratedItemWorkflowMenu({
  image,
  workflowsOnly,
  isLightbox,
}: GeneratedItemWorkflowMenuProps) {
  const workflowId = image.workflow.id;
  const { updateImages } = useUpdateImageStepMetadata();
  const { copied, copy } = useClipboard();
  const status = useGenerationStatus();
  const isMember = status.tier !== 'free';

  const outputType = image.type === 'video' ? 'video' : 'image';

  const { groups, isCompatible } = useGeneratedItemWorkflows({
    outputType,
    ecosystemKey: image.ecosystemKey,
  });

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleRemix(seed?: number | null) {
    dialogStore.closeById('generated-image');

    generationGraphStore.setData({
      params: { ...image.params, seed: seed ?? undefined },
      resources: image.resources ?? [],
      runType: 'remix',
      remixOfId: image.remixOfId,
    });
  }

  function handleDeleteImage() {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Delete image',
        message:
          'Are you sure that you want to delete this image? This is a destructive action and cannot be undone.',
        labels: { cancel: 'Cancel', confirm: 'Yes, delete it' },
        confirmProps: { color: 'red' },
        autoFocusConfirm: true,
        zIndex: isLightbox ? 401 : imageGenerationDrawerZIndex + 2,
        onConfirm: () => {
          updateImages([
            {
              workflowId,
              stepName: image.stepName,
              images: {
                [image.id]: { hidden: true },
              },
            },
          ]);
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const hasWorkflows = groups.some((g) => g.workflows.length > 0);

  return (
    <>
      {/* Remix actions */}
      {!workflowsOnly && (
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
          {group.workflows.map((workflow) => {
            const disabled = workflow.memberOnly && !isMember;

            if (disabled) {
              return (
                <div key={workflow.id} className="px-1 pt-1">
                  <RequireMembership>
                    <SupportButtonPolymorphic
                      icon={IconDiamond}
                      position="right"
                      className="w-full !px-3 !py-2"
                    >
                      <Text size="sm">{workflow.label}</Text>
                    </SupportButtonPolymorphic>
                  </RequireMembership>
                </div>
              );
            }

            return (
              <Menu.Item
                key={workflow.id}
                onClick={() =>
                  applyWorkflowWithCheck({
                    workflowId: workflow.id,
                    image,
                    compatible: workflow.compatible,
                    isLightbox,
                  })
                }
              >
                <Text size="sm">{workflow.label}</Text>
              </Menu.Item>
            );
          })}
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
