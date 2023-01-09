import { createStyles, Stack, StackProps } from '@mantine/core';

export function AbsoluteCenter({
  children,
  className,
  zIndex,
  ...props
}: StackProps & { zIndex?: number }) {
  const { classes, cx } = useStyles({ zIndex });
  return (
    <Stack className={cx(classes.root, className)} {...props}>
      {children}
    </Stack>
  );
}

const useStyles = createStyles((theme, { zIndex = 10 }: { zIndex?: number }) => ({
  root: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    zIndex,
  },
}));
