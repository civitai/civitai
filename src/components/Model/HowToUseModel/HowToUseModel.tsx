import { Text, TextProps, Tooltip } from '@mantine/core';
import { ModelType } from '~/shared/utils/prisma/enums';
import type { IconProps } from '@tabler/icons-react';
import { IconInfoSquareRounded } from '@tabler/icons-react';

const RESOURCE_GUIDE_URL = 'https://education.civitai.com/civitais-guide-to-resource-types/';

// Section anchors in the Education resource-types guide. A type the guide has no section for opens
// the guide at the top.
const instructions: Partial<Record<ModelType, string>> = {
  [ModelType.Checkpoint]: '#models',
  [ModelType.TextualInversion]: '#Embeddings',
  [ModelType.AestheticGradient]: '',
  [ModelType.LORA]: '#Loras',
  [ModelType.LoCon]: '#Loras',
  [ModelType.DoRA]: '#Loras',
  [ModelType.Hypernetwork]: '',
  [ModelType.Controlnet]: '',
  [ModelType.Poses]: '',
  [ModelType.VAE]: '#VAE',
  [ModelType.Wildcards]: '#wildcards',
  [ModelType.Workflows]: '#workflows',
  [ModelType.MotionModule]: '',
};

/** The "How to use this" link for a model type, or null when the type has no guide entry. */
export function howToUseModelHref(type: ModelType) {
  const anchor = instructions[type];
  return anchor === undefined ? null : `${RESOURCE_GUIDE_URL}${anchor}`;
}

export const HowToUseModel = ({ type }: ModelFileAlertProps) => {
  const href = howToUseModelHref(type);
  if (!href) return null;

  return <HowToButton href={href} />;
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
        c="dimmed"
        style={{ lineHeight: 1 }}
        aria-label={tooltip}
      >
        <IconInfoSquareRounded size={size} {...iconProps} />
      </Text>
    </Tooltip>
  );
};

type HowToButtonProps = IconProps & { href: string; tooltip?: string; size?: number };
