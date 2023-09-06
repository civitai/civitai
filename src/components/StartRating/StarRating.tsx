import { Box, Group, createStyles } from '@mantine/core';

const useStyles = createStyles((theme) => ({
  gauge: {
    appearance: 'none',
    backgroundColor: 'rgba(255, 255, 255, .3)',
    border: 0,
    // Clip path for the same IconStar from tabler-icons
    clipPath:
      'polygon(54.598% 84.544%,26.516% 100%,31.88% 67.264%,9.131% 44.082%,40.525% 39.319%,54.566% 9.536%,68.606% 39.319%,100% 44.082%,77.251% 67.264%,82.615% 100%)',

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

export function StarRating({ value, count = 5, size = 20, fractions = 10 }: Props) {
  const { classes } = useStyles();

  return (
    <Group spacing={2} align="center" h={size} noWrap>
      {Array.from({ length: Math.floor(count) }).map((_, index) => {
        const rounded = Math.floor(value);
        const isFilled = index < rounded;
        const delta = !isFilled && index === rounded ? value - rounded : 0;
        const step = 100 / fractions;
        const adjustedDelta = Math.floor((delta * 100) / step) * step;

        return (
          <Box
            component="progress"
            key={index}
            className={classes.gauge}
            value={isFilled ? 100 : adjustedDelta}
            max="100"
            sx={{ position: 'relative', width: size, height: size, marginTop: -4 }}
          />
        );
      })}
    </Group>
  );
}

type Props = { value: number; count?: number; size?: number; fractions?: number };
