import { Group, Text } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconQuestionCircle } from '@tabler/icons';

const instructions = {
  [ModelType.Checkpoint]: '#fine-tuned-model-checkpoints-dreambooth-models',
  [ModelType.TextualInversion]: '#textual-inversions',
  [ModelType.AestheticGradient]: '#aesthetic-gradients',
  [ModelType.LORA]: '#lora',
  [ModelType.Hypernetwork]: '#lora',
};

export const HowToUseModel = ({ type }: ModelFileAlertProps) => {
  return (
    <Text
      component="a"
      href={`https://github.com/civitai/civitai/wiki/How-to-use-models${instructions[type]}`}
      target="_blank"
      rel="nofollow"
      td="underline"
      size="xs"
      color="dimmed"
    >
      <Group spacing={4}>
        <IconQuestionCircle size={20} />
        How to use this
      </Group>
    </Text>
  );
};

type ModelFileAlertProps = {
  type: ModelType;
};
