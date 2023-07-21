import { Container, ContainerProps, createStyles } from '@mantine/core';

const useStyles = createStyles((theme) => ({
  bleedRight: {
    padding: 0,
  },
}));

export const HomeBlockWrapper = ({ children, bleedRight, ...props }: Props) => {
  const { classes, cx } = useStyles();

  return (
    <Container px={0} fluid {...props}>
      <Container size="xl" className={cx({ [classes.bleedRight]: bleedRight })}>
        {children}
      </Container>
    </Container>
  );
};

type Props = ContainerProps & { bleedRight?: boolean };
