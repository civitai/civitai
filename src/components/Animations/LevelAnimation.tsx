import { Flex, FlexProps } from '@mantine/core';
import Lottie, { LottieProps } from 'react-lottie';
import * as levelAnimation from '~/utils/lotties/level-up-animation.json';

export function LevelAnimation({ lottieProps, ...props }: Props) {
  return (
    <Flex {...props}>
      <Lottie {...lottieProps} options={{ animationData: levelAnimation, loop: false }} />
    </Flex>
  );
}

type Props = FlexProps & { lottieProps?: Omit<LottieProps, 'options'> };
