import { Center, createStyles, Loader, Text } from '@mantine/core';

export function PageLoader({ text }: { text?: string }) {
  const { classes } = useStyles();
  return (
    <Center className={classes.root}>
      <Loader />
      {text && <Text>{text}</Text>}
    </Center>
  );
}

const useStyles = createStyles((theme) => ({
  root: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    flexDirection: 'column',
  },
}));
