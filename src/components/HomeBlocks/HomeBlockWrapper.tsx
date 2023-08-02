import { ContainerProps } from '@mantine/core';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';

export const HomeBlockWrapper = ({ children, bleedRight, ...props }: Props) => {
  return (
    <MasonryContainer fluid {...props}>
      {children}
    </MasonryContainer>
  );
};

type Props = ContainerProps & { bleedRight?: boolean };
