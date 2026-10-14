import { Button, Text } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useField } from 'form-graph/react';
import {
  avatarStarterSrc,
  avatarStyleCharacterSrc,
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
import { capitalize } from '~/utils/string-helpers';
import { AvatarProfilePictureButton } from './AvatarProfilePictureButton';

type AvatarParams = {
  avatarStyle?: string;
  avatarReference?: string;
  avatarParentImage?: string;
  avatarPalette?: string;
};

function describeReference(params: AvatarParams) {
  const { avatarReference: reference, avatarStyle: style, avatarParentImage: parent } = params;
  if (parent) return { src: parent, label: 'Earlier result' };
  const starter = style && reference ? findAvatarStarter(style, reference) : undefined;
  return starter
    ? { src: avatarStarterSrc(starter, 120), label: capitalize(starter.character) }
    : undefined;
}

function ReferenceStrip({ workflow }: { workflow: WorkflowData }) {
  const params = workflow.params as AvatarParams;
  const style = params.avatarStyle ? avatarStyleByKey.get(params.avatarStyle) : undefined;
  const modelId = workflow.resources.find((resource) => resource.model?.type === 'Checkpoint')?.id;
  const usesReference =
    modelId == null || avatarEditModelByVersionId.get(modelId)?.usesReference !== false;
  const reference =
    usesReference || params.avatarParentImage
      ? describeReference(params)
      : style && {
          src: avatarStyleCharacterSrc(style.key, undefined, 120),
          label: 'none, restyled with the style itself',
        };
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
      </div>
    </div>
  );
}

function RefineActions({ output, styleKey }: { output: BlobData; styleKey?: string }) {
  const form = useActiveGenerationForm((state) => state.store);
  const refiningFrom = useField<string>(form ?? null, 'avatarParentImage')?.value;
  if (output.type !== 'image' || output.blockedReason) return null;
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

export function avatarQueueItemProps(workflow: WorkflowData) {
  if (workflow.params.workflow !== AVATAR_WORKFLOW) return {};
  const params = workflow.params as AvatarParams;
  return {
    beforeOutputs: <ReferenceStrip workflow={workflow} />,
    renderOutputFooter: (output: BlobData) => (
      <RefineActions output={output} styleKey={params.avatarStyle} />
    ),
  };
}
