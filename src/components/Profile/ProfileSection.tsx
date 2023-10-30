import { InView } from 'react-intersection-observer';
import { AspectRatio, createStyles, Grid, Group, Skeleton, Stack, Text } from '@mantine/core';

type Props = {
  title: string;
  icon: React.ReactNode;
  children?: React.ReactNode;
};

export const useProfileSectionStyles = createStyles<
  string,
  {
    count?: number;
    rowCount?: number;
    columnCount?: number | string;
    widthGrid?: string;
    widthCarousel?: string;
  }
>(
  (
    theme,
    { count = 4, rowCount = 2, columnCount, widthGrid = '380px', widthCarousel = '280px' } = {}
  ) => {
    return {
      scrollGrid: {
        display: 'grid',
        columnGap: theme.spacing.md,
        gridAutoRows: 0,
        overflow: 'hidden',
        gridAutoFlow: 'column',
        gridTemplateColumns: `repeat(${count}, ${widthCarousel})`,
        gridTemplateRows: 'auto',
        scrollSnapType: 'x mandatory',
        overflowX: 'auto',
        marginRight: -theme.spacing.md,
        marginLeft: -theme.spacing.md,
        paddingLeft: theme.spacing.md,
        paddingBottom: theme.spacing.md,

        '& > *': {
          scrollSnapAlign: 'center',
        },

        [theme.fn.largerThan('lg')]: {
          gridTemplateColumns: `repeat(${count}, calc(25% - ${theme.spacing.md}px))`,
        },
        [theme.fn.largerThan('xl')]: {
          gridTemplateColumns: `repeat(${count}, calc(20% - ${theme.spacing.md}px))`,
        },
      },
      grid: {
        display: 'grid',
        gridTemplateColumns: `repeat(${columnCount ?? 'auto-fill'}, minmax(${widthGrid}, 1fr))`,
        columnGap: theme.spacing.md,
        gridTemplateRows: `repeat(${rowCount ?? '2'}, auto)`,
        gridAutoRows: 0,
        overflow: 'hidden',
        marginTop: -theme.spacing.md,

        '& > *': {
          marginTop: theme.spacing.md,
        },

        [theme.fn.smallerThan('sm')]: {
          gridAutoFlow: 'column',
          gridTemplateColumns: `repeat(${count}, ${widthCarousel})`,
          gridTemplateRows: 'auto',
          scrollSnapType: 'x mandatory',
          overflowX: 'auto',
          marginRight: -theme.spacing.md,
          marginLeft: -theme.spacing.md,
          paddingLeft: theme.spacing.md,

          '& > *': {
            scrollSnapAlign: 'center',
          },
        },
      },
    };
  }
);

export const ProfileSectionPreview = ({
  rowCount = 1,
  columnCount = 4,
}: {
  rowCount?: number;
  columnCount?: number;
}) => {
  return (
    <Stack spacing="md" w="100%">
      <Skeleton width="33%" height={22} />
      <Grid>
        {Array.from({ length: rowCount }).map((_, i) => {
          return (
            <Group key={i} spacing={0} noWrap w="100%">
              {Array.from({ length: columnCount }).map((_, j) => {
                return (
                  <Grid.Col xs={11} md={12 / columnCount} key={j}>
                    <AspectRatio ratio={7 / 9}>
                      <Skeleton width="100%" />
                    </AspectRatio>
                  </Grid.Col>
                );
              })}
            </Group>
          );
        })}
      </Grid>
    </Stack>
  );
};
export const ProfileSection = ({ children, title, icon }: Props) => {
  return (
    <Stack spacing="md">
      <Group>
        <Text size={28} weight={590}>
          {title}
        </Text>
        {icon}
      </Group>
      {children}
    </Stack>
  );
};
