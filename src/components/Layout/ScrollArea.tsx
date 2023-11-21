import { Box, BoxProps, createStyles } from '@mantine/core';
import { forwardRef } from 'react';

// export function ScrollArea({ children, className, ...props }: BoxProps) {
//   const { classes, cx } = useStyles();
//   return (
//     <Box className={cx(classes.root, className)} py="md" {...props}>
//       {children}
//     </Box>
//   );
// }

export const ScrollArea = forwardRef<HTMLDivElement, BoxProps>(
  ({ children, className, ...props }, ref) => {
    const { classes, cx } = useStyles();
    return (
      <Box className={cx(classes.root, className)} py="md" {...props}>
        {children}
      </Box>
    );
  }
);

ScrollArea.displayName = 'ScrollArea';

const useStyles = createStyles(() => ({
  root: {
    height: '100%',
    width: '100%',
    flex: 1,
    overflowY: 'auto',
    willChange: 'transform',
  },
}));
