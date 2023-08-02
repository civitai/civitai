import { Container, ContainerProps, createStyles } from '@mantine/core';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';

const useStyles = createStyles((theme) => ({
  bleedRight: {
    padding: 0,
  },
}));

export const HomeBlockWrapper = ({ children, bleedRight, ...props }: Props) => {
  const { classes, cx } = useStyles();

  return (
    <MasonryContainer px={0} fluid {...props}>
      {children}
    </MasonryContainer>
  );
};

type Props = ContainerProps & { bleedRight?: boolean };
