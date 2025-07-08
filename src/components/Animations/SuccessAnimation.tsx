import type { FlexProps } from '@mantine/core';
import { Flex } from '@mantine/core';
import type { LottieComponentProps } from 'lottie-react';
import Lottie from 'lottie-react';
import successAnimation from '~/utils/lotties/success-animation.json';

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
        aria-roledescription="presentation"
        {...lottieProps}
        animationData={successAnimation}
        loop={false}
      />
      {children}
    </Flex>
  );
}

type Props = FlexProps & { lottieProps?: Omit<LottieComponentProps, 'options' | 'animationData'> };
