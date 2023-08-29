import { Box, Group, createStyles } from '@mantine/core';

const useStyles = createStyles((theme) => ({
  gauge: {
    appearance: 'none',
    width: '100%',
    height: '100%',
    backgroundColor: 'rgba(255, 255, 255, .3)',
    clipPath:
      'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);',

    '&::-webkit-progress-bar': {
      backgroundColor: 'rgba(255, 255, 255, .3)',
    },

    '&::-webkit-progress-value': {
      backgroundColor: theme.colors.yellow[8],
    },

    '&::-moz-progress-bar': {
      backgroundColor: theme.colors.yellow[8],
    },
  },
}));

export function StarRating({ value, count = 5, size = 20 }: Props) {
  const { classes } = useStyles();

  return (
    <Group spacing={2} align="center">
      {Array.from({ length: Math.floor(count) }).map((_, index) => {
        const delta = value - Math.floor(value);
        const isFilled = index < Math.floor(value);

        return (
          <Box key={index} sx={{ position: 'relative', width: size, height: size }}>
            <progress className={classes.gauge} value={isFilled ? 1 : delta} />
          </Box>
        );
      })}
    </Group>
  );
}

type Props = { value: number; count?: number; size?: number };
