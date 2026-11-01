import type { WorkflowDisplay } from '~/components/ImageGeneration/workflow-display';
import {
  avatarStarterSrc,
  avatarStyleCharacterSrc,
  findAvatarStarter,
} from '~/shared/constants/avatar-starters';
import {
  avatarEditModelByVersionId,
  avatarPalettes,
  avatarStyleByKey,
} from '~/shared/constants/avatar-styles.constants';
import type { WorkflowData } from '~/shared/orchestrator/workflow-data';
import { capitalize } from '~/utils/string-helpers';

type AvatarParams = {
  avatarStyle?: string;
  avatarReference?: string;
  avatarParentImage?: string;
  avatarPalette?: string;
};

/** The prompt is hidden, so the card says which style, reference and colours made the avatar. */
function summary(workflow: WorkflowData) {
  const params = workflow.params as AvatarParams;
  const style = params.avatarStyle ? avatarStyleByKey.get(params.avatarStyle) : undefined;
  const modelId = workflow.resources.find((resource) => resource.model?.type === 'Checkpoint')?.id;
  const usesReference =
    modelId == null || avatarEditModelByVersionId.get(modelId)?.usesReference !== false;
  const starter =
    style && params.avatarReference
      ? findAvatarStarter(style.key, params.avatarReference)
      : undefined;
  const reference = params.avatarParentImage
    ? { image: params.avatarParentImage, label: 'Earlier result' }
    : !usesReference
    ? style && {
        image: avatarStyleCharacterSrc(style.key, undefined, 120),
        label: 'none, restyled with the style itself',
      }
    : starter && { image: avatarStarterSrc(starter, 120), label: capitalize(starter.character) };
  if (!reference) return undefined;
  const palette = style?.fixedPalette
    ? undefined
    : avatarPalettes.find((p) => p.key === params.avatarPalette);

  return {
    image: reference.image,
    rows: [
      { label: 'Style', value: style?.name ?? 'Avatar' },
      { label: 'Reference', value: reference.label },
      ...(palette ? [{ label: 'Colours', value: palette.label }] : []),
    ],
  };
}

export const avatarDisplay: WorkflowDisplay = {
  summary,
  outputActions: [
    {
      kind: 'fillForm',
      label: 'Refine',
      activeLabel: 'Refining',
      fields: (output, workflow) => ({
        avatarStyle: (workflow.params as AvatarParams).avatarStyle,
        avatarParentImage: output.url,
      }),
    },
    { kind: 'profilePicture' },
  ],
};
