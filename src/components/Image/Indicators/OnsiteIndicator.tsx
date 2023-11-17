import { createStyles } from '@mantine/core';

export function OnsiteIndicator() {
  const { classes } = useStyles();
  return <div className={classes.onsiteIndicator} title="Created on Civitai" />;
}

const useStyles = createStyles((theme) => ({
  onsiteIndicator: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
    borderStyle: 'solid',
    borderWidth: '0 0 15px 15px',
    borderColor: `transparent transparent ${theme.colors.yellow[6]} transparent`,
    zIndex: 10,
    opacity: 0.5,
    ['&:hover']: {
      opacity: 0.8,
    },
  },
}));
