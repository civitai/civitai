import type { FlexProps } from '@mantine/core';
import { Flex } from '@mantine/core';
import type { LottieComponentProps } from 'lottie-react';
import Lottie from 'lottie-react';
import levelAnimation from '~/utils/lotties/level-up-animation.json';
import rankAnimation from '~/utils/lotties/rank-up-animation.json';

export function LevelAnimation({ lottieProps, type = 'level', ...props }: Props) {
  return (
    <Flex {...props}>
      <Lottie
        {...lottieProps}
        animationData={type === 'level' ? levelAnimation : rankAnimation}
        loop={false}
      />
    </Flex>
  );
}

type Props = FlexProps & {
  lottieProps?: Omit<LottieComponentProps, 'options' | 'animationData'>;
  type?: 'level' | 'rank';
};
