import { AspectRatio, createStyles, Group, Skeleton, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import React from 'react';
import { UserWithProfile } from '~/types/router';
import { containerQuery } from '~/utils/mantine-css-helpers';

type Props = {
  title: string;
  icon: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
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
      title: {
        fontSize: '32px',
        [containerQuery.smallerThan('sm')]: {
          fontSize: '24px',
        },
      },
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

        '&:hover': {
          [`& .${scrollGridRef}, & .${gridRef}`]: {
            '&::-webkit-scrollbar': {
              opacity: 1,
            },
            '&::-webkit-scrollbar-thumb': {
              backgroundColor:
                theme.colorScheme === 'dark'
                  ? theme.fn.rgba(theme.white, 0.5)
                  : theme.fn.rgba(theme.black, 0.5),
            },
          },
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
          // backdropFilter: 'blur(8px)',
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
        paddingBottom: theme.spacing.md,

        '&::-webkit-scrollbar': {
          background: 'transparent',
          opacity: 0,
          height: 8,
        },
        '&::-webkit-scrollbar-thumb': {
          borderRadius: 4,
        },

        '& > *': {
          marginTop: theme.spacing.md,
        },

        [containerQuery.smallerThan('sm')]: {
          gridAutoFlow: 'column',
          gridTemplateColumns: `repeat(${count}, ${widthCarousel})`,
          gridTemplateRows: 'auto',
          scrollSnapType: 'x mandatory',
          overflowX: 'auto',
          marginRight: -theme.spacing.md,
          marginLeft: -theme.spacing.md,
          paddingLeft: theme.spacing.md,
          paddingRight: theme.spacing.md,

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
  columnCount = 7,
}: {
  rowCount?: number;
  columnCount?: number;
}) => {
  const { classes } = useProfileSectionStyles({
    count: columnCount * rowCount,
    rowCount,
    widthGrid: '280px',
  });
  return (
    <Stack spacing="md" w="100%" style={{ overflow: 'hidden' }}>
      <Skeleton width="33%" height={22} />
      <div className={classes.grid}>
        {Array.from({ length: rowCount * columnCount }).map((_, i) => {
          return (
            <AspectRatio key={i} ratio={7 / 9}>
              <Skeleton width="100%" />
            </AspectRatio>
          );
        })}
      </div>
    </Stack>
  );
};
export const ProfileSection = ({ children, title, icon, action }: Props) => {
  const { theme, classes } = useProfileSectionStyles({});
  return (
    <Stack spacing="md">
      <Group position="apart" align="center">
        <Group>
          <ThemeIcon size="xl" color="dark" variant="default">
            {icon}
          </ThemeIcon>
          <Text
            className={classes.title}
            weight={590}
            color={theme.colorScheme === 'dark' ? 'white' : 'black'}
          >
            {title}
          </Text>
        </Group>
        {action}
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
