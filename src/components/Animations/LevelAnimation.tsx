import type { FlexProps } from '@mantine/core';
import { Flex } from '@mantine/core';
import type { LottieProps } from 'react-lottie';
import Lottie from 'react-lottie';
import * as levelAnimation from '~/utils/lotties/level-up-animation.json';
import * as rankAnimation from '~/utils/lotties/rank-up-animation.json';

export function LevelAnimation({ lottieProps, type = 'level', ...props }: Props) {
  return (
    <Flex {...props}>
      <Lottie
        {...lottieProps}
        options={{ animationData: type === 'level' ? levelAnimation : rankAnimation, loop: false }}
      />
    </Flex>
  );
}

type Props = FlexProps & { lottieProps?: Omit<LottieProps, 'options'>; type?: 'level' | 'rank' };
