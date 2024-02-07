import { Text, TextProps, Tooltip } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconInfoSquareRounded, TablerIconsProps } from '@tabler/icons-react';

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
    <HowToButton
      href={`https://github.com/civitai/civitai/wiki/How-to-use-models${instructions[type]}`}
    />
  );
};

type ModelFileAlertProps = {
  type: ModelType;
};

export const HowToButton = ({
  href,
  size = 20,
  tooltip = 'How to use this',
  ...iconProps
}: HowToButtonProps) => {
  return (
    <Tooltip label={tooltip} position="left" withArrow>
      <Text
        component="a"
        href={href}
        target="_blank"
        rel="nofollow noreferrer"
        td="underline"
        size="xs"
        color="dimmed"
        sx={{ lineHeight: 1 }}
      >
        <IconInfoSquareRounded size={size} {...iconProps} />
      </Text>
    </Tooltip>
  );
};

type HowToButtonProps = TablerIconsProps & { href: string; tooltip?: string; size?: number };
