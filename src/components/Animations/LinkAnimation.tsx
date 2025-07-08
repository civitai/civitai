import type { FlexProps } from '@mantine/core';
import { Flex } from '@mantine/core';
import type { LottieComponentProps } from 'lottie-react';
import Lottie from 'lottie-react';
import linkAnimation from '~/utils/lotties/link-animation.json';

export function LinkAnimation({ lottieProps, ...props }: Props) {
  return (
    <Flex {...props}>
      <Lottie {...lottieProps} animationData={linkAnimation} />
    </Flex>
  );
}

type Props = FlexProps & { lottieProps?: Omit<LottieComponentProps, 'options' | 'animationData'> };
