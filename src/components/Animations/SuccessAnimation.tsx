import type { FlexProps } from '@mantine/core';
import { Flex } from '@mantine/core';
import type { LottieProps } from 'react-lottie';
import Lottie from 'react-lottie';
import * as successAnimation from '~/utils/lotties/success-animation.json';

export function SuccessAnimation({
  direction = 'column',
  children,
  lottieProps,
  ...flexProps
}: Props) {
  return (
    <Flex direction={direction} {...flexProps}>
      <Lottie
        style={{ margin: 0 }}
        ariaRole="presentation"
        {...lottieProps}
        options={{ animationData: successAnimation, loop: false }}
      />
      {children}
    </Flex>
  );
}

type Props = FlexProps & { lottieProps?: Omit<LottieProps, 'options'> };
