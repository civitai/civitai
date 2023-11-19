import { Box, createStyles } from '@mantine/core';

export function ScrollArea({
  children,
  className,
  ...props
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { classes, cx } = useStyles();
  return (
    <Box className={cx(classes.root, className)} {...props} py="md" id="scrollArea">
      {children}
    </Box>
  );
}

const useStyles = createStyles(() => ({
  root: {
    height: '100%',
    width: '100%',
    flex: 1,
    overflow: 'auto',
    willChange: 'transform',
    // transform: 'translate3D(0,0,0)',
  },
}));
