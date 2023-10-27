import { Text, Tooltip } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconInfoSquareRounded } from '@tabler/icons-react';

const instructions: Partial<Record<ModelType, string>> = {
  [ModelType.Checkpoint]: '#fine-tuned-model-checkpoints-dreambooth-models',
  [ModelType.TextualInversion]: '#textual-inversions',
  [ModelType.AestheticGradient]: '#aesthetic-gradients',
  [ModelType.LORA]: '#lora',
  [ModelType.LoCon]: '#locon',
  [ModelType.Hypernetwork]: '#hypernetwork',
  [ModelType.Controlnet]: '#controlnet',
  [ModelType.Poses]: '#poses',
  [ModelType.Wildcards]: '#wildcards',
  [ModelType.MotionModule]: '#motion-module',
};

export const HowToUseModel = ({ type }: ModelFileAlertProps) => {
  if (!instructions[type]) return null;
  return (
    <Tooltip label="How to use this" position="left" withArrow>
      <Text
        component="a"
        href={`https://github.com/civitai/civitai/wiki/How-to-use-models${instructions[type]}`}
        target="_blank"
        rel="nofollow"
        td="underline"
        size="xs"
        color="dimmed"
        sx={{ lineHeight: 1 }}
      >
        <IconInfoSquareRounded size={20} />
      </Text>
    </Tooltip>
  );
};

type ModelFileAlertProps = {
  type: ModelType;
};
