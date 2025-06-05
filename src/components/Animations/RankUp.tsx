import type { FlexProps } from '@mantine/core';
import { Flex } from '@mantine/core';
import type { LottieProps } from 'react-lottie';
import Lottie from 'react-lottie';
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
