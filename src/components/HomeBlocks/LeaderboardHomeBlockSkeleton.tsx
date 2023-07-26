import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { AspectRatio, Group, Skeleton } from '@mantine/core';

export const LeaderboardsHomeBlockSkeleton = () => {
  return (
    <HomeBlockWrapper py="md">
      <Skeleton width="10%" height={20} mb={10} />
      <Skeleton width="40%" height={20} mb={10} />
      <Skeleton width="30%" height={20} mb={30} />

      <Group spacing={12}>
        <AspectRatio ratio={1} w="calc(25% - 12px)">
          <Skeleton width="100%" height="120" />
        </AspectRatio>
        <AspectRatio ratio={1} w="calc(25% - 12px)">
          <Skeleton width="100%" height="120" />
        </AspectRatio>
        <AspectRatio ratio={1} w="calc(25% - 12px)">
          <Skeleton width="100%" height="120" />
        </AspectRatio>
        <AspectRatio ratio={1} w="calc(25% - 12px)">
          <Skeleton width="100%" height="120" />
        </AspectRatio>
      </Group>
    </HomeBlockWrapper>
  );
};
