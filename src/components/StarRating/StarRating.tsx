import { Box, createStyles, Group, Text } from '@mantine/core';
import { IconStar, IconStarHalf } from '@tabler/icons';
import { useState, useMemo } from 'react';

export type StarRatingProps = {
  rating?: number;
};

export function StarRating({ rating: initialRating = 0 }: StarRatingProps) {
  // rating out of 10
  const [rating, setRating] = useState(7);
  const { classes, cx } = useStyles();

  const booleanMapping = useMemo(
    () =>
      [...Array(5)].reduce<Array<[boolean, boolean]>>((acc, value, index) => {
        const current = index + 1;
        return [...acc, [current * 2 - 1 <= rating, current * 2 <= rating]];
      }, []),
    [rating]
  );

  return (
    <Group spacing={0}>
      {booleanMapping.map(([half, full], i) => (
        <Box key={i} className={classes.starContainer}>
          <Text>
            <IconStar
              size={18}
              stroke={1}
              className={cx(classes.fullStar, {
                [classes.filled]: full,
              })}
            />
          </Text>
          {half && !full && (
            <Text className={classes.halfStar}>
              <IconStarHalf size={18} className={classes.filled} />
            </Text>
          )}
        </Box>
      ))}
    </Group>
  );
}

// TODO - colors for dark mode
const useStyles = createStyles((theme) => ({
  starContainer: {
    position: 'relative',
  },
  fullStar: {
    stroke: theme.colors.gray[5],
  },
  halfStar: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
  },
  filled: {
    stroke: theme.colors.yellow[5],
    fill: theme.colors.yellow[5],
  },
}));
