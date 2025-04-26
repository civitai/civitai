import { AspectRatio, Group, Skeleton, Stack, Text, ThemeIcon, Box, BoxProps } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import React, { forwardRef } from 'react';
import { UserWithProfile } from '~/types/router';
import styles from './ProfileSection.module.scss';

type Props = {
  title: string;
  icon: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
};

export interface ProfileSectionProps extends BoxProps {
  user: UserWithProfile & { username: string };
}

export const ProfileSection = forwardRef<HTMLDivElement, ProfileSectionProps>((props, ref) => {
  const { user, className, ...others } = props;

  return (
    <Box
      className={`${styles.profileSection} ${className}`}
      {...others}
      ref={ref}
    />
  );
});

ProfileSection.displayName = 'ProfileSection';

export const ProfileSectionPreview = ({
  rowCount = 1,
  columnCount = 7,
}: {
  rowCount?: number;
  columnCount?: number;
}) => {
  return (
    <Stack spacing="md" w="100%" style={{ overflow: 'hidden' }}>
      <Skeleton width="33%" height={22} />
      <div className={styles.grid}>
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
