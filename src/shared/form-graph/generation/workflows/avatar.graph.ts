import { defineGraph, rootScope } from 'form-graph';
import type { GenerationCtx } from '~/shared/generation/context';
import {
  AVATAR_WORKFLOW,
  DEFAULT_AVATAR_STYLE,
  avatarCharacters,
  avatarEditModels,
  avatarPalettes,
  avatarStyleByKey,
  avatarStyles,
} from '~/shared/constants/avatar-styles.constants';
import { enumDef } from '../../defs';
import { checkpointDef } from '../checkpoint';
import { getResourceSelectOptions, imagesDef, quantityDef, textDef } from '../defs';
import type { ModelType } from '~/shared/utils/prisma/enums';

// `modelWins` keeps the Nano Banana field from resetting another family's version to its default.
const avatarModelVersions = {
  label: 'Model',
  options: avatarEditModels.map(({ label, versionId }) => ({ label, value: versionId })),
};

// The selector marks a model unavailable when its base model is not listed, and the avatar models
// span several families.
const avatarModelBaseModels = [
  ...new Set(
    ['NanoBanana', 'OpenAI', 'Krea2'].flatMap(
      (ecosystem) =>
        getResourceSelectOptions(ecosystem, ['Checkpoint'] as ModelType[])[0]?.baseModels ?? []
    )
  ),
];

function avatarModelDef(ext: GenerationCtx) {
  const def = checkpointDef({
    ecosystem: 'NanoBanana',
    workflow: AVATAR_WORKFLOW,
    ext,
    versions: avatarModelVersions,
    defaultModelId: avatarEditModels[0].versionId,
    modelLocked: true,
    modelWins: true,
  });
  return {
    ...def,
    meta: (value: Parameters<typeof def.meta>[0]) => {
      const meta = def.meta(value);
      return {
        ...meta,
        options: {
          ...meta.options,
          resources: [
            {
              type: 'Checkpoint' as ModelType,
              baseModels: avatarModelBaseModels,
              partialSupport: [],
            },
          ],
        },
      };
    },
  };
}

export const avatar = defineGraph<GenerationCtx>()
  .field('model', ({ _ext }) => avatarModelDef(_ext))
  .field('images', imagesDef({ min: 1, max: 1, aspectRatios: ['1:1'] }))
  .field(
    'avatarStyle',
    enumDef({
      options: avatarStyles.map((style) => ({ label: style.name, value: style.key })),
      default: DEFAULT_AVATAR_STYLE,
    })
  )
  // 'cover', 'starter:<character>', or, when refining, the parent image's URL.
  .field('avatarReference', { ...textDef('Reference', 2000), default: 'cover' })
  .field('avatarPalette', ({ avatarStyle }: { avatarStyle: string }) =>
    avatarStyleByKey.get(avatarStyle)?.fixedPalette
      ? null
      : enumDef({
          options: avatarPalettes.map(({ key, label }) => ({ value: key, label })),
        })
  )
  .field('avatarCharacter', ({ avatarStyle }: { avatarStyle: string }) =>
    avatarStyleByKey.get(avatarStyle)?.characters
      ? enumDef({ options: avatarCharacters.map(({ key, label }) => ({ value: key, label })) })
      : null
  )
  .field('avatarParentImage', textDef('Parent image', 2000))
  .field('quantity', ({ _ext }) => ({
    ...quantityDef({ max: _ext.limits.maxQuantity }),
    scope: rootScope('image'),
  }));
