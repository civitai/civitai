import { Button, Text, UnstyledButton } from '@mantine/core';
import { IconCornerLeftUp, IconSparkles } from '@tabler/icons-react';
import { useField } from 'form-graph/react';
import {
  avatarStarterSrc,
  avatarStyleCoverSrc,
  findAvatarStarter,
} from '~/shared/constants/avatar-starters';
import {
  AVATAR_WORKFLOW,
  avatarEditModelByVersionId,
  avatarPalettes,
  avatarStyleByKey,
} from '~/shared/constants/avatar-styles.constants';
import type { BlobData, WorkflowData } from '~/shared/orchestrator/workflow-data';
import { useActiveGenerationForm } from '~/store/active-generation-form.store';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { AvatarProfilePictureButton } from './AvatarProfilePictureButton';

type AvatarParams = {
  avatarStyle?: string;
  avatarReference?: string;
  avatarParentImage?: string;
  avatarPalette?: string;
};

const capitalise = (value: string) => value[0].toUpperCase() + value.slice(1);

function describeReference(params: AvatarParams) {
  const { avatarReference: reference, avatarStyle: style, avatarParentImage: parent } = params;
  if (!reference) return undefined;
  if (reference === parent) return { src: reference, label: 'Earlier result' };
  const starter = style ? findAvatarStarter(style, reference) : undefined;
  return starter
    ? { src: avatarStarterSrc(starter, 120), label: capitalise(starter.character) }
    : undefined;
}

function ReferenceStrip({
  workflow,
  parentItemId,
}: {
  workflow: WorkflowData;
  parentItemId?: string;
}) {
  const params = workflow.params as AvatarParams;
  const style = params.avatarStyle ? avatarStyleByKey.get(params.avatarStyle) : undefined;
  const modelId = workflow.resources.find((resource) => resource.model?.type === 'Checkpoint')?.id;
  const usesReference =
    modelId == null || avatarEditModelByVersionId.get(modelId)?.usesReference !== false;
  const coverSrc = style ? avatarStyleCoverSrc(style.key, 120) : undefined;
  const reference =
    usesReference || params.avatarParentImage
      ? describeReference(params)
      : coverSrc
      ? { src: coverSrc, label: 'none, restyled with the style itself' }
      : undefined;
  if (!reference) return null;
  const palette = avatarPalettes.find((p) => p.key === params.avatarPalette);

  return (
    <div className="flex items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={reference.src} alt="Reference" className="size-14 shrink-0 rounded object-cover" />
      <div className="min-w-0">
        <Text size="xs">
          <span className="text-gray-6 dark:text-dark-2">Style:</span> {style?.name ?? 'Avatar'}
        </Text>
        <Text size="xs">
          <span className="text-gray-6 dark:text-dark-2">Reference:</span> {reference.label}
          {palette && !style?.fixedPalette && (
            <>
              {' · '}
              <span className="text-gray-6 dark:text-dark-2">Colours:</span> {palette.label}
            </>
          )}
        </Text>
        {params.avatarParentImage && parentItemId && (
          <UnstyledButton
            className="flex items-center gap-1 text-xs text-blue-6 hover:underline dark:text-blue-4"
            onClick={() =>
              document.getElementById(parentItemId)?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            <IconCornerLeftUp size={12} />
            Refined from an earlier result
          </UnstyledButton>
        )}
      </div>
    </div>
  );
}

function RefineActions({ output, styleKey }: { output: BlobData; styleKey?: string }) {
  const form = useActiveGenerationForm((state) => state.store);
  const refiningFrom = useField<string>(form ?? null, 'avatarParentImage')?.value;
  if (output.type !== 'image' || !output.available || output.blockedReason) return null;
  const active = refiningFrom === output.url;

  return (
    <div className="flex flex-wrap gap-1">
      <Button
        size="compact-sm"
        className="flex-1"
        variant={active ? 'filled' : 'light'}
        leftSection={<IconSparkles size={14} />}
        onClick={() => {
          form?.set({
            ...(styleKey ? { avatarStyle: styleKey } : {}),
            avatarReference: output.url,
            avatarParentImage: output.url,
          });
          generationGraphPanel.setView('generate');
        }}
      >
        {active ? 'Refining' : 'Refine'}
      </Button>
      <AvatarProfilePictureButton output={output} />
    </div>
  );
}

/** `queueIdByOutputUrl` finds the card of the result a refine started from. */
export function avatarQueueItemProps(
  workflow: WorkflowData,
  queueIdByOutputUrl: ReadonlyMap<string, string>
) {
  if (workflow.params.workflow !== AVATAR_WORKFLOW) return {};
  const params = workflow.params as AvatarParams;
  const parentItemId = params.avatarParentImage
    ? queueIdByOutputUrl.get(params.avatarParentImage)
    : undefined;
  return {
    beforeOutputs: <ReferenceStrip workflow={workflow} parentItemId={parentItemId} />,
    renderOutputFooter: (output: BlobData) => (
      <RefineActions output={output} styleKey={params.avatarStyle} />
    ),
  };
}
