import { Flex, FlexProps } from '@mantine/core';
import Lottie, { LottieProps } from 'react-lottie';
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
        options={{ animationData: successAnimation, loop: false }}
        style={{ margin: 0 }}
        ariaRole="presentation"
        {...lottieProps}
      />
      {children}
    </Flex>
  );
}

type Props = FlexProps & { lottieProps?: Omit<LottieProps, 'options'> };
