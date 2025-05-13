import {
  AspectRatio,
  Group,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  useComputedColorScheme,
} from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import React from 'react';
import { UserWithProfile } from '~/types/router';
import { containerQuery } from '~/utils/mantine-css-helpers';
import classes from '~/components/Profile/ProfileSection.module.scss';

type Props = {
  title: string;
  icon: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
};

export type ProfileSectionProps = { user: UserWithProfile & { username: string } };

export const ProfileSectionPreview = ({
  rowCount = 1,
  columnCount = 7,
}: {
  rowCount?: number;
  columnCount?: number;
}) => {
  return (
    <Stack
      style={{
        '--count': columnCount * rowCount,
        '--row-count': rowCount,
        '--width-grid': '280px',
      }}
      gap="md"
      w="100%"
      style={{ overflow: 'hidden' }}
    >
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
  const colorScheme = useComputedColorScheme('dark');
  return (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Group>
          <ThemeIcon size="xl" color="dark" variant="default">
            {icon}
          </ThemeIcon>
          <Text
            className={classes.title}
            weight={590}
            color={colorScheme === 'dark' ? 'white' : 'black'}
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
      <Text fz={32} align="center">
        No results found
      </Text>
      <Text align="center">
        {"Try adjusting your search or filters to find what you're looking for"}
      </Text>
    </Stack>
  );
};
