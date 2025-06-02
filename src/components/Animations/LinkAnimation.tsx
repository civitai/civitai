import type { FlexProps } from '@mantine/core';
import { Flex } from '@mantine/core';
import type { LottieProps } from 'react-lottie';
import Lottie from 'react-lottie';
import * as linkAnimation from '~/utils/lotties/link-animation.json';

export function LinkAnimation({ lottieProps, ...props }: Props) {
  return (
    <Flex {...props}>
      <Lottie {...lottieProps} options={{ animationData: linkAnimation }} />
    </Flex>
  );
}

type Props = FlexProps & { lottieProps?: Omit<LottieProps, 'options'> };
