import { createStyles, Center, Loader } from '@mantine/core';
export function PageLoader() {
  const { classes } = useStyles();
  return (
    <Center className={classes.root}>
      <Loader />
    </Center>
  );
}

const useStyles = createStyles((theme) => ({
  root: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
  },
}));
