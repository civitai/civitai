import { Flex, FlexProps } from '@mantine/core';
import Lottie, { LottieProps } from 'react-lottie';
// Temporarily using the level up animation until we have a crown animation
import * as rankAnimation from '~/utils/lotties/level-up-animation.json';

export function RankUpAnimation({ lottieProps, ...props }: Props) {
  return (
    <Flex {...props}>
      <Lottie {...lottieProps} options={{ animationData: rankAnimation, loop: false }} />
    </Flex>
  );
}

type Props = FlexProps & { lottieProps?: Omit<LottieProps, 'options'> };
