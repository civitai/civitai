import { InView } from 'react-intersection-observer';
import {
  AspectRatio,
  createStyles,
  Grid,
  Group,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  useMantineTheme,
} from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import { UserWithProfile } from '~/types/router';

type Props = {
  title: string;
  icon: React.ReactNode;
  children?: React.ReactNode;
};

export type ProfileSectionProps = { user: UserWithProfile & { username: string } };

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
    { count = 4, rowCount = 2, columnCount, widthGrid = '380px', widthCarousel = '280px' } = {},
    getRef
  ) => {
    const scrollGridRef = getRef('scrollGrid');
    const gridRef = getRef('grid');
    const nullStateRef = getRef('nullState');

    return {
      profileSection: {
        paddingLeft: theme.spacing.md,
        paddingRight: theme.spacing.md,
        paddingTop: theme.spacing.xl,
        paddingBottom: theme.spacing.xl,
        marginRight: -theme.spacing.md,
        marginLeft: -theme.spacing.md,

        '&:nth-of-type(even)': {
          background:
            theme.colorScheme === 'dark'
              ? theme.colors.dark[8]
              : theme.fn.darken(theme.colors.gray[0], 0.01),
        },
      },
      loader: {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 101,
      },
      nullState: {
        ref: nullStateRef,
        position: 'relative',
      },
      loading: {
        position: 'relative',

        '&::after': {
          position: 'absolute',
          height: '100%',
          width: '100%',
          top: 0,
          left: 0,
          content: '""',
          background: 'rgba(0,0,0, 0.3)',
          zIndex: 100,
          backdropFilter: 'blur(8px)',
        },
      },
      scrollGrid: {
        ref: scrollGridRef,
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
      },
      grid: {
        ref: gridRef,
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
    <Stack spacing="md" w="100%" style={{ overflow: 'hidden' }}>
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
  const theme = useMantineTheme();
  return (
    <Stack spacing="md">
      <Group>
        <ThemeIcon size="xl" variant="light">
          {icon}
        </ThemeIcon>
        <Text size={28} weight={590} color={theme.colorScheme === 'dark' ? 'white' : 'black'}>
          {title}
        </Text>
      </Group>
      {children}
    </Stack>
  );
};

export const ProfileSectionNoResults = () => {
  return (
    <Stack align="center" py="lg">
      <ThemeIcon size={128} radius={100}>
        <IconCloudOff size={80} />
      </ThemeIcon>
      <Text size={32} align="center">
        No results found
      </Text>
      <Text align="center">
        {"Try adjusting your search or filters to find what you're looking for"}
      </Text>
    </Stack>
  );
};
